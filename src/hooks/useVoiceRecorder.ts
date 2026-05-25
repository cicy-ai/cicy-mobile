import * as Haptics from 'expo-haptics';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { transcribeAudio } from '@/src/api/stt';
import { getDeviceLocale, normalizeChineseVariant } from '@/src/lib/locale';

const IS_WEB = Platform.OS === 'web';
const MIN_RECORD_MS = 350;

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

type Options = {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
  language?: string;
};

// Two backends:
//   1. Native: expo-speech-recognition (iOS Speech, Android Google Speech).
//      Free, low latency, but Android requires a recognition service installed.
//   2. Whisper: record with expo-audio, upload to /api/stt on the server.
//      Works on every device; depends on the user's cicy-code STT config.
//
// We pick lazily — try native first, fall back to whisper only if the device
// reports no recognition service. Set FORCE_WHISPER = true to always use the
// server (e.g. for a more accurate model than the OS provides).
const FORCE_WHISPER = false;

export function useVoiceRecorder({ onTranscript, onError, language }: Options) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const partialRef = useRef('');
  const permittedRef = useRef(false);
  const useWhisperRef = useRef<boolean>(FORCE_WHISPER);
  const startingRef = useRef(false);
  const pendingStopRef = useRef(false);
  const startedAtRef = useRef(0);

  const lang = language || getDeviceLocale().nativeSpeechLang || 'zh-CN';

  // expo-audio recorder (only used when in whisper mode).
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => {
    if (IS_WEB) { permittedRef.current = true; return; }
    // Decide backend on mount.
    if (!FORCE_WHISPER) {
      try {
        const ok = ExpoSpeechRecognitionModule.isRecognitionAvailable();
        useWhisperRef.current = !ok;
      } catch {
        useWhisperRef.current = true;
      }
    }
    // Pre-request the permission we'll actually use.
    if (useWhisperRef.current) {
      AudioModule.getRecordingPermissionsAsync()
        .then((cur) => { if (cur.granted) permittedRef.current = true; })
        .catch(() => {});
      setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
    } else {
      ExpoSpeechRecognitionModule.requestPermissionsAsync()
        .then(({ granted }) => { permittedRef.current = granted; })
        .catch(() => {});
    }
  }, []);

  // --- Native speech-recognition events (only fire when in native mode) ---
  useSpeechRecognitionEvent('result', (e) => {
    if (useWhisperRef.current) return;
    if (e.results?.[0]) {
      partialRef.current = e.results[0].transcript;
      if (e.isFinal) {
        onTranscript(partialRef.current.trim());
        partialRef.current = '';
        setPhase('idle');
      }
    }
  });

  useSpeechRecognitionEvent('error', (e) => {
    if (useWhisperRef.current) return;
    if (e.error === 'no-speech') { setPhase('idle'); return; }
    onError?.(e.message || e.error);
    setPhase('idle');
  });

  useSpeechRecognitionEvent('end', () => {
    if (useWhisperRef.current) return;
    if (partialRef.current.trim()) {
      onTranscript(partialRef.current.trim());
      partialRef.current = '';
    }
    setPhase('idle');
  });

  async function ensurePermission(): Promise<boolean> {
    if (IS_WEB) return true;
    if (permittedRef.current) return true;
    if (useWhisperRef.current) {
      const cur = await AudioModule.getRecordingPermissionsAsync();
      if (cur.granted) { permittedRef.current = true; return true; }
      const next = await AudioModule.requestRecordingPermissionsAsync();
      permittedRef.current = next.granted;
      return next.granted;
    }
    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    permittedRef.current = granted;
    return granted;
  }

  async function start() {
    if (phase !== 'idle' || startingRef.current) return;
    if (!permittedRef.current && !(await ensurePermission())) {
      onError?.('Microphone permission denied');
      return;
    }
    startingRef.current = true;
    pendingStopRef.current = false;
    try {
      if (useWhisperRef.current) {
        // Whisper mode: record with expo-audio.
        await recorder.prepareToRecordAsync();
        recorder.record();
        startedAtRef.current = Date.now();
      } else {
        // Native speech-recognition mode.
        partialRef.current = '';
        await ExpoSpeechRecognitionModule.start({
          lang,
          interimResults: false,
          continuous: false,
        });
      }
      setPhase('recording');
      if (!IS_WEB) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      // If stop() was queued while we were starting, run it now.
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        setTimeout(() => stop(), 50);
      }
    } catch (e: any) {
      onError?.(`Could not start: ${String(e?.message ?? e)}`);
      setPhase('idle');
    } finally {
      startingRef.current = false;
    }
  }

  async function stop(opts?: { cancel?: boolean }) {
    if (startingRef.current) {
      pendingStopRef.current = true;
      return;
    }
    if (phase === 'idle') return;

    if (useWhisperRef.current) {
      const elapsed = Date.now() - startedAtRef.current;
      try { await recorder.stop(); } catch { /* uri may still be valid */ }
      if (opts?.cancel || elapsed < MIN_RECORD_MS) {
        setPhase('idle');
        return;
      }
      const uri = recorder.uri;
      if (!uri) {
        setPhase('idle');
        onError?.('No recording produced');
        return;
      }
      setPhase('transcribing');
      try {
        const { text } = await transcribeAudio(uri, { language: getDeviceLocale().whisperLang });
        const trimmed = normalizeChineseVariant(text).trim();
        if (trimmed) onTranscript(trimmed);
      } catch (e: any) {
        onError?.(String(e?.message ?? e));
      } finally {
        setPhase('idle');
      }
      return;
    }

    // Native speech-recognition mode.
    try {
      if (opts?.cancel) {
        await ExpoSpeechRecognitionModule.abort();
        partialRef.current = '';
        setPhase('idle');
      } else {
        await ExpoSpeechRecognitionModule.stop();
        // Safety net: if no result/end event arrives within 2s, force-reset.
        setTimeout(() => {
          if (partialRef.current === '') setPhase('idle');
        }, 2000);
      }
    } catch (e: any) {
      onError?.(`Stop error: ${String(e?.message ?? e)}`);
      setPhase('idle');
    }
  }

  return {
    phase,
    start,
    stop,
    durationMs: 0,
  };
}
