import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { getDeviceLocale } from '@/src/lib/locale';

const IS_WEB = Platform.OS === 'web';
const KEEP_AWAKE_TAG = 'cicy-meeting';
const DEFAULT_SILENCE_MS = 1800;

export type MeetingPhase = 'idle' | 'recording' | 'paused';

type Options = {
  language?: string;
  onError?: (msg: string) => void;
  // When set, finalized speech is auto-flushed to this callback after a short
  // silence (one "turn"), ChatGPT-style. The buffer holds only finalized text
  // not yet sent.
  onAutoSend?: (text: string) => void;
  autoSend?: boolean;
  silenceMs?: number;
};

// Long-form, real-time, on-device transcription for the "meeting assistant"
// mode. Runs the native recognizer continuously with interim results and
// auto-restarts whenever the OS ends a session (iOS resets periodically;
// Android ends on silence), accumulating finalized segments into `committed`
// and the live partial into `interim`.
//
// With autoSend on, each finalized turn is flushed to onAutoSend after
// `silenceMs` of no new speech — so the user just talks and the agent receives
// turn-by-turn (it records / acts as a meeting assistant on the backend).
//
// Assumes foreground + screen-on (we hold a keep-awake lock): native speech
// recognition does not run reliably in the background.
export function useMeetingTranscriber({
  language, onError, onAutoSend, autoSend = false, silenceMs = DEFAULT_SILENCE_MS,
}: Options = {}) {
  const [phase, setPhase] = useState<MeetingPhase>('idle');
  const [committed, setCommitted] = useState('');
  const [interim, setInterim] = useState('');
  const [level, setLevel] = useState(0); // 0..1, for the waveform
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sentCount, setSentCount] = useState(0);

  // Refs the event handlers read without re-subscribing.
  const wantRecordingRef = useRef(false); // true between start() and stop()
  // Off by default: forcing on-device when no offline model is installed can
  // error (esp. Android, where installedLocales is empty unless using the
  // google.android.as service). We flip it on only when positively confirmed.
  const onDeviceRef = useRef(false);
  const startedAtRef = useRef(0);
  const accumBeforePauseRef = useRef(0); // elapsed frozen across pauses
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-send buffering.
  const unsentRef = useRef(''); // finalized text not yet auto-sent
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSendRef = useRef(autoSend);
  const onAutoSendRef = useRef(onAutoSend);
  const silenceMsRef = useRef(silenceMs);
  useEffect(() => { autoSendRef.current = autoSend; }, [autoSend]);
  useEffect(() => { onAutoSendRef.current = onAutoSend; }, [onAutoSend]);
  useEffect(() => { silenceMsRef.current = silenceMs; }, [silenceMs]);

  const lang = language || getDeviceLocale().nativeSpeechLang || 'en-US';

  // Decide on-device availability once.
  useEffect(() => {
    if (IS_WEB) return;
    try {
      ExpoSpeechRecognitionModule.getSupportedLocales({})
        .then((res: any) => {
          const installed: string[] = res?.installedLocales ?? [];
          if (installed.length) {
            const base = lang.split('-')[0].toLowerCase();
            onDeviceRef.current = installed.some(
              (l) => l.toLowerCase() === lang.toLowerCase() || l.toLowerCase().startsWith(base),
            );
          }
        })
        .catch(() => {});
    } catch {
      /* keep default */
    }
    return () => {
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      stopTick();
      clearSilence();
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startTick() {
    stopTick();
    tickRef.current = setInterval(() => {
      setElapsedMs(accumBeforePauseRef.current + (Date.now() - startedAtRef.current));
    }, 500);
  }
  function stopTick() {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }

  function clearSilence() {
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  }

  // Flush the finalized-but-unsent buffer as one turn.
  function flushAutoSend() {
    clearSilence();
    const text = unsentRef.current.trim();
    if (!text) return;
    unsentRef.current = '';
    onAutoSendRef.current?.(text);
    setSentCount((n) => n + 1);
  }

  // Reset the silence countdown — called on every result while recording.
  function bumpSilence() {
    if (!autoSendRef.current) return;
    clearSilence();
    silenceTimerRef.current = setTimeout(flushAutoSend, silenceMsRef.current);
  }

  const beginSession = useCallback(async () => {
    await ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: onDeviceRef.current,
      addsPunctuation: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 200 },
    });
  }, [lang]);

  // --- recognizer events ---
  useSpeechRecognitionEvent('result', (e) => {
    const r = e.results?.[0];
    if (!r) return;
    if (e.isFinal) {
      const seg = r.transcript.trim();
      if (seg) {
        setCommitted((prev) => (prev ? `${prev} ${seg}` : seg));
        unsentRef.current = unsentRef.current ? `${unsentRef.current} ${seg}` : seg;
      }
      setInterim('');
      bumpSilence();
    } else {
      setInterim(r.transcript);
      bumpSilence(); // still speaking → keep the turn open
    }
  });

  useSpeechRecognitionEvent('volumechange', (e) => {
    const v = Math.max(0, Math.min(1, (e.value + 2) / 12));
    setLevel(v);
  });

  useSpeechRecognitionEvent('end', () => {
    if (wantRecordingRef.current && phaseRef.current === 'recording') {
      beginSession().catch((err) => {
        onError?.(String(err?.message ?? err));
        hardStop();
      });
    }
  });

  useSpeechRecognitionEvent('error', (e) => {
    if (e.error === 'no-speech') return; // normal between sentences
    onError?.(e.message || e.error);
  });

  const phaseRef = useRef<MeetingPhase>('idle');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  async function ensurePermission(): Promise<boolean> {
    if (IS_WEB) return true;
    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return granted;
  }

  const start = useCallback(async () => {
    if (phase !== 'idle') return;
    if (!(await ensurePermission())) {
      onError?.('permission-denied');
      return;
    }
    wantRecordingRef.current = true;
    accumBeforePauseRef.current = 0;
    unsentRef.current = '';
    setCommitted('');
    setInterim('');
    setElapsedMs(0);
    setSentCount(0);
    try {
      await beginSession();
      startedAtRef.current = Date.now();
      startTick();
      setPhase('recording');
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
      if (!IS_WEB) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch (e: any) {
      wantRecordingRef.current = false;
      onError?.(String(e?.message ?? e));
      setPhase('idle');
    }
  }, [phase, beginSession, onError]);

  const pause = useCallback(async () => {
    if (phase !== 'recording') return;
    wantRecordingRef.current = false;
    accumBeforePauseRef.current += Date.now() - startedAtRef.current;
    stopTick();
    setLevel(0);
    try { await ExpoSpeechRecognitionModule.stop(); } catch {}
    flushAutoSend(); // send whatever turn is buffered before pausing
    setPhase('paused');
  }, [phase]);

  const resume = useCallback(async () => {
    if (phase !== 'paused') return;
    wantRecordingRef.current = true;
    try {
      await beginSession();
      startedAtRef.current = Date.now();
      startTick();
      setPhase('recording');
    } catch (e: any) {
      onError?.(String(e?.message ?? e));
    }
  }, [phase, beginSession, onError]);

  function hardStop() {
    wantRecordingRef.current = false;
    stopTick();
    clearSilence();
    setLevel(0);
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    setPhase('idle');
  }

  const stop = useCallback(async () => {
    if (phase === 'idle') return;
    wantRecordingRef.current = false;
    if (phase === 'recording') {
      accumBeforePauseRef.current += Date.now() - startedAtRef.current;
    }
    try { await ExpoSpeechRecognitionModule.stop(); } catch {}
    // Fold any lingering interim into committed + unsent so nothing is lost,
    // then flush the final turn.
    setInterim((cur) => {
      const tail = cur.trim();
      if (tail) {
        setCommitted((prev) => (prev ? `${prev} ${tail}` : tail));
        unsentRef.current = unsentRef.current ? `${unsentRef.current} ${tail}` : tail;
      }
      return '';
    });
    flushAutoSend();
    hardStop();
  }, [phase]);

  const clear = useCallback(() => {
    setCommitted('');
    setInterim('');
    unsentRef.current = '';
    accumBeforePauseRef.current = 0;
    setElapsedMs(0);
    setSentCount(0);
  }, []);

  // Full transcript including the live tail (for a manual "send everything").
  const transcript = (committed + (interim ? ` ${interim}` : '')).trim();

  return {
    phase,
    committed,
    interim,
    transcript,
    level,
    elapsedMs,
    sentCount,
    start,
    pause,
    resume,
    stop,
    clear,
  };
}
