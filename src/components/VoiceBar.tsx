import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Text } from './Text';
import { useVoiceRecorder } from '@/src/hooks/useVoiceRecorder';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  onTranscript: (text: string) => void;
  onError?: (msg: string) => void;
  disabled?: boolean;
  language?: string;
};

// Full-width push-to-talk bar (WeChat-style). The bar IS the affordance —
// no separate icon. Hold to record, release to send.
export function VoiceBar({ onTranscript, onError, disabled, language }: Props) {
  const theme = useTheme();
  const { phase, start, stop, durationMs } = useVoiceRecorder({ onTranscript, onError, language });

  const isRecording = phase === 'recording';
  const isBusy = phase === 'transcribing';

  // Subtle pulse on the bar while recording — calms the experience vs a hard
  // red flash.
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (isRecording) {
      pulse.value = withRepeat(
        withSequence(withTiming(1, { duration: 700 }), withTiming(0, { duration: 700 })),
        -1,
        true,
      );
    } else {
      pulse.value = withTiming(0, { duration: 200 });
    }
  }, [isRecording, pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: 0.35 + pulse.value * 0.65 }));

  const bgColor = isRecording ? theme.accent : theme.surface;
  const fgColor = isRecording ? theme.accentText : theme.text;
  const label = isBusy
    ? 'Transcribing…'
    : isRecording
    ? `松开发送  ${formatDuration(durationMs / 1000)}`
    : '按住说话';

  return (
    <Pressable
      onPressIn={start}
      onPressOut={() => stop()}
      disabled={disabled || isBusy}
      style={[
        styles.bar,
        {
          backgroundColor: bgColor,
          borderColor: isRecording ? 'transparent' : theme.border,
          opacity: isBusy ? 0.6 : 1,
        },
      ]}
    >
      {isRecording ? (
        <Animated.View style={[styles.dot, { backgroundColor: theme.accentText }, dotStyle]} />
      ) : null}
      <Text variant="bodyMedium" style={{ color: fgColor }}>
        {label}
      </Text>
    </Pressable>
  );
}

function formatDuration(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  bar: {
    flex: 1,
    minHeight: 48,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
