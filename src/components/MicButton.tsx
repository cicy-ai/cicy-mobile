import * as Haptics from 'expo-haptics';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { transcribeAudio } from '@/src/api/stt';
import { useTheme } from '@/src/theme';
import i18n from '@/src/i18n';

type Phase = 'idle' | 'recording' | 'transcribing';

type Props = {
  // Called with the recognised text once /api/stt returns. If you want to
  // commit-and-send, do it here; if you want to populate an input, also do it
  // here. The button itself is unopinionated.
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
  disabled?: boolean;
  size?: number;
  language?: string;
};

const IS_WEB = Platform.OS === 'web';
const MIN_RECORD_MS = 350; // ignore accidental taps

export function MicButton({ onTranscript, onError, disabled, size = 36, language }: Props) {
  const theme = useTheme();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<Phase>('idle');
  const [permissionAsked, setPermissionAsked] = useState(false);
  const startedAtRef = useRef<number>(0);

  // Set audio mode once so the input session is set up correctly on iOS.
  useEffect(() => {
    if (IS_WEB) return;
    setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => undefined);
  }, []);

  async function ensurePermission(): Promise<boolean> {
    if (IS_WEB) return true;
    const cur = await AudioModule.getRecordingPermissionsAsync();
    if (cur.granted) return true;
    setPermissionAsked(true);
    const next = await AudioModule.requestRecordingPermissionsAsync();
    return next.granted;
  }

  async function start() {
    if (disabled || phase !== 'idle') return;
    try {
      if (!(await ensurePermission())) {
        onError?.(i18n.t('voice.micDenied'));
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      startedAtRef.current = Date.now();
      setPhase('recording');
      if (!IS_WEB) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    } catch (e: any) {
      setPhase('idle');
      onError?.(i18n.t('voice.recordStartFailed', { error: String(e?.message ?? e) }));
    }
  }

  async function stop() {
    if (phase !== 'recording') return;
    const elapsed = Date.now() - startedAtRef.current;
    try {
      await recorder.stop();
    } catch {
      /* ignore — uri may still be valid */
    }
    if (elapsed < MIN_RECORD_MS) {
      setPhase('idle');
      return; // accidental tap, drop silently
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

  // Visual state
  const isRecording = phase === 'recording';
  const isBusy = phase === 'transcribing';

  return (
    <PressableScale
      onPressIn={start}
      onPressOut={stop}
      // No haptic on press — start() emits its own when recording actually begins.
      haptic={false}
      disabled={disabled || isBusy}
      scaleTo={0.95}
      style={[
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: isRecording ? theme.danger : theme.surfaceMuted,
        },
      ]}
    >
      {isBusy ? (
        <View style={[styles.dot, { backgroundColor: theme.textMuted }]} />
      ) : (
        <Text style={{ color: isRecording ? theme.accentText : theme.text, fontSize: 16 }}>
          {isRecording ? '●' : '🎙'}
        </Text>
      )}
      {isRecording ? (
        <View style={styles.timer}>
          <Text variant="caption" tone="muted">
            {formatDuration((state.durationMillis ?? 0) / 1000)}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

function formatDuration(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center', position: 'relative' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: {
    position: 'absolute',
    bottom: -22,
    left: -8,
    right: -8,
    alignItems: 'center',
  },
});
