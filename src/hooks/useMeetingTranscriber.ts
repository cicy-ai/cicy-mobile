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

export type MeetingPhase = 'idle' | 'recording' | 'paused';

type Options = {
  language?: string;
  onError?: (msg: string) => void;
};

// Long-form, real-time, on-device transcription for the "meeting" mode.
//
// Unlike useVoiceRecorder (push-to-talk, one-shot), this runs the native
// recognizer continuously with interim results and *auto-restarts* it whenever
// the OS ends a session (iOS resets periodically; Android ends on silence).
// We accumulate finalized segments into `committed` and keep the live partial
// in `interim`. On-device recognition keeps it offline + free; we fall back to
// network recognition only if the locale has no on-device model.
//
// Assumes the app stays foreground + screen-on (we hold a keep-awake lock):
// native speech recognition does not run reliably in the background.
export function useMeetingTranscriber({ language, onError }: Options = {}) {
  const [phase, setPhase] = useState<MeetingPhase>('idle');
  const [committed, setCommitted] = useState('');
  const [interim, setInterim] = useState('');
  const [level, setLevel] = useState(0); // 0..1, for the waveform
  const [elapsedMs, setElapsedMs] = useState(0);

  // Refs the event handlers read without re-subscribing.
  const wantRecordingRef = useRef(false); // true between start() and stop()
  // Off by default: forcing on-device when no offline model is installed can
  // error (esp. Android, where installedLocales is empty unless using the
  // google.android.as service). We flip it on only when positively confirmed.
  const onDeviceRef = useRef(false);
  const startedAtRef = useRef(0);
  const accumBeforePauseRef = useRef(0); // elapsed frozen across pauses
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const lang = language || getDeviceLocale().nativeSpeechLang || 'en-US';

  // Decide on-device availability once.
  useEffect(() => {
    if (IS_WEB) return;
    try {
      ExpoSpeechRecognitionModule.getSupportedLocales({})
        .then((res: any) => {
          const installed: string[] = res?.installedLocales ?? [];
          // If we can't tell, optimistically keep on-device; the recognizer
          // falls back internally and `error` will surface real problems.
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
      // Safety net on unmount.
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      stopTick();
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
      if (seg) setCommitted((prev) => (prev ? `${prev} ${seg}` : seg));
      setInterim('');
    } else {
      setInterim(r.transcript);
    }
  });

  useSpeechRecognitionEvent('volumechange', (e) => {
    // value: -2 (silence) .. 10 (loud). Map to 0..1.
    const v = Math.max(0, Math.min(1, (e.value + 2) / 12));
    setLevel(v);
  });

  useSpeechRecognitionEvent('end', () => {
    // The OS ended this session. If the user is still recording, restart to
    // keep the long-form transcription going.
    if (wantRecordingRef.current && phaseRef.current === 'recording') {
      beginSession().catch((err) => {
        onError?.(String(err?.message ?? err));
        hardStop();
      });
    }
  });

  useSpeechRecognitionEvent('error', (e) => {
    // Silence between sentences is normal in a meeting — let `end` restart us.
    if (e.error === 'no-speech') return;
    onError?.(e.message || e.error);
  });

  // Mirror `phase` into a ref so the `end` handler sees the latest value.
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
    setCommitted('');
    setInterim('');
    setElapsedMs(0);
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
    // Fold any lingering interim into committed so nothing is lost.
    setInterim((cur) => {
      if (cur.trim()) setCommitted((prev) => (prev ? `${prev} ${cur.trim()}` : cur.trim()));
      return '';
    });
    hardStop();
  }, [phase]);

  const clear = useCallback(() => {
    setCommitted('');
    setInterim('');
    accumBeforePauseRef.current = 0;
    setElapsedMs(0);
  }, []);

  // Full transcript including the live tail (for "send to agent").
  const transcript = (committed + (interim ? ` ${interim}` : '')).trim();

  return {
    phase,
    committed,
    interim,
    transcript,
    level,
    elapsedMs,
    start,
    pause,
    resume,
    stop,
    clear,
  };
}
