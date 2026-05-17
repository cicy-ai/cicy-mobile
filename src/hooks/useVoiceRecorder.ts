import * as Haptics from 'expo-haptics';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { transcribeAudio } from '@/src/api/stt';

const IS_WEB = Platform.OS === 'web';
const MIN_RECORD_MS = 350;

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

type Options = {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
  language?: string;
};

export function useVoiceRecorder({ onTranscript, onError, language }: Options) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    if (IS_WEB) return;
    setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => undefined);
  }, []);

  async function ensurePermission(): Promise<boolean> {
    if (IS_WEB) return true;
    const cur = await AudioModule.getRecordingPermissionsAsync();
    if (cur.granted) return true;
    const next = await AudioModule.requestRecordingPermissionsAsync();
    return next.granted;
  }

  async function start() {
    if (phase !== 'idle') return;
    try {
      if (!(await ensurePermission())) {
        onError?.('Microphone permission denied');
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAtRef.current = Date.now();
      setPhase('recording');
      if (!IS_WEB) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    } catch (e: any) {
      setPhase('idle');
      onError?.(`Could not start recording: ${String(e?.message ?? e)}`);
    }
  }

  async function stop(opts?: { cancel?: boolean }) {
    if (phase !== 'recording') return;
    const elapsed = Date.now() - startedAtRef.current;
    try {
      await recorder.stop();
    } catch {
      /* swallow — uri may still be valid */
    }
    if (opts?.cancel) {
      setPhase('idle');
      return;
    }
    if (elapsed < MIN_RECORD_MS) {
      setPhase('idle');
      return; // accidental tap
    }
    const uri = recorder.uri;
    if (!uri) {
      setPhase('idle');
      onError?.('No recording produced');
      return;
    }
    setPhase('transcribing');
    try {
      const { text } = await transcribeAudio(uri, { language });
      onTranscript(text.trim());
    } catch (e: any) {
      onError?.(String(e?.message ?? e));
    } finally {
      setPhase('idle');
    }
  }

  return {
    phase,
    start,
    stop,
    durationMs: state.durationMillis ?? 0,
  };
}
