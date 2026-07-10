// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

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
  type RecordingOptions,
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
// Backend choice:
//   Android → ALWAYS whisper. Chinese-ROM recognition services exist (so the
//   availability probe passes) but their accuracy is garbage — 用户实测
//   "android stt垃圾". Server whisper is dramatically better and /api/stt is
//   already required for the meeting flow anyway.
//   iOS → native Apple Speech (good quality, zero latency), whisper fallback.
const FORCE_WHISPER = Platform.OS === 'android';

// Whisper only needs 16 kHz mono — the default HIGH_QUALITY preset (44.1 kHz
// stereo 128 kbps) makes the upload 4-5× larger for zero accuracy gain, and on
// Android every voice message rides the tunnel to /api/stt. ~24 kbps AAC mono
// keeps a 10 s clip around 30 KB.
const WHISPER_RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 24000,
};

export function useVoiceRecorder({ onTranscript, onError, language }: Options) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  // Phase mirror for async paths. The queued-stop in start() fires a `stop`
  // closure captured while phase was still 'idle' — checking the STATE there
  // made it early-return and never stop the recorder (quick-tap on 按住说话
  // left the mic recording forever, and the next tap sent the ambient audio
  // as a transcript). Refs don't go stale.
  const phaseRef = useRef<VoicePhase>('idle');
  const updatePhase = (p: VoicePhase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const partialRef = useRef('');
  const permittedRef = useRef(false);
  const useWhisperRef = useRef<boolean>(FORCE_WHISPER);
  const startingRef = useRef(false);
  const pendingStopRef = useRef(false);
  const startedAtRef = useRef(0);

  const lang = language || getDeviceLocale().nativeSpeechLang || 'zh-CN';

  // expo-audio recorder (only used when in whisper mode).
  const recorder = useAudioRecorder(WHISPER_RECORDING);

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
        updatePhase('idle');
      }
    }
  });

  useSpeechRecognitionEvent('error', (e) => {
    if (useWhisperRef.current) return;
    if (e.error === 'no-speech') { updatePhase('idle'); return; }
    onError?.(e.message || e.error);
    updatePhase('idle');
  });

  useSpeechRecognitionEvent('end', () => {
    if (useWhisperRef.current) return;
    if (partialRef.current.trim()) {
      onTranscript(partialRef.current.trim());
      partialRef.current = '';
    }
    updatePhase('idle');
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
    if (phaseRef.current !== 'idle' || startingRef.current) return;
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
      updatePhase('recording');
      if (!IS_WEB) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      // If stop() was queued while we were starting, run it now.
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        setTimeout(() => stop(), 50);
      }
    } catch (e: any) {
      onError?.(`Could not start: ${String(e?.message ?? e)}`);
      updatePhase('idle');
    } finally {
      startingRef.current = false;
    }
  }

  async function stop(opts?: { cancel?: boolean }) {
    if (startingRef.current) {
      pendingStopRef.current = true;
      return;
    }
    if (phaseRef.current === 'idle') return;

    if (useWhisperRef.current) {
      const elapsed = Date.now() - startedAtRef.current;
      try { await recorder.stop(); } catch { /* uri may still be valid */ }
      if (opts?.cancel || elapsed < MIN_RECORD_MS) {
        updatePhase('idle');
        return;
      }
      const uri = recorder.uri;
      if (!uri) {
        updatePhase('idle');
        onError?.('No recording produced');
        return;
      }
      updatePhase('transcribing');
      try {
        const { text } = await transcribeAudio(uri, { language: getDeviceLocale().whisperLang });
        const trimmed = (await normalizeChineseVariant(text)).trim();
        if (trimmed) onTranscript(trimmed);
      } catch (e: any) {
        onError?.(String(e?.message ?? e));
      } finally {
        updatePhase('idle');
      }
      return;
    }

    // Native speech-recognition mode.
    try {
      if (opts?.cancel) {
        await ExpoSpeechRecognitionModule.abort();
        partialRef.current = '';
        updatePhase('idle');
      } else {
        await ExpoSpeechRecognitionModule.stop();
        // Safety net: if no result/end event arrives within 2s, force-reset.
        setTimeout(() => {
          if (partialRef.current === '') updatePhase('idle');
        }, 2000);
      }
    } catch (e: any) {
      onError?.(`Stop error: ${String(e?.message ?? e)}`);
      updatePhase('idle');
    }
  }

  return {
    phase,
    start,
    stop,
    durationMs: 0,
  };
}
