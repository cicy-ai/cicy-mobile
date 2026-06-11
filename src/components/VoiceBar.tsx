import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';

import { RecordingDot } from './RecordingDot';
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
  const { t } = useTranslation();
  const theme = useTheme();
  const { phase, start, stop, durationMs } = useVoiceRecorder({ onTranscript, onError, language });

  const isRecording = phase === 'recording';
  const isBusy = phase === 'transcribing';

  const bgColor = isRecording ? theme.accent : theme.surface;
  const fgColor = isRecording ? theme.accentText : theme.text;
  const label = isBusy
    ? t('voice.transcribing')
    : isRecording
    ? `${t('voice.releaseToSend')}  ${formatDuration(durationMs / 1000)}`
    : t('voice.holdToTalk');

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
      {isRecording ? <RecordingDot color={theme.accentText} size={8} /> : null}
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
});
