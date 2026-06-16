import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { useMeetingTranscriber } from '@/src/hooks/useMeetingTranscriber';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  agentTitle: string;
  // Called with each finalized turn (after a short silence) — the chat screen
  // sends it to the agent. Auto-send is always on in this bar.
  onTurn: (text: string) => void;
  onClose: () => void;
  onError?: (msg: string) => void;
  language?: string;
};

// In-conversation live-recording bar (replaces the composer while active).
// Speech auto-sends turn-by-turn into the chat history; the bar only shows the
// live draft of the current turn + a waveform + transport. The committed turns
// appear as your own bubbles in the history above.
export function LiveRecordBar({ agentTitle, onTurn, onClose, onError, language }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();

  const { phase, interim, level, elapsedMs, sentCount, start, pause, resume, stop } =
    useMeetingTranscriber({ language, autoSend: true, onAutoSend: onTurn, onError });

  // Auto-start on mount (the user tapped the mic to get here); stop on unmount.
  useEffect(() => {
    start();
    return () => { stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isRecording = phase === 'recording';
  const bars = [0.35, 0.6, 1, 0.6, 0.35].map((w) => Math.max(0.12, level * w));

  async function end() {
    await stop();
    onClose();
  }

  return (
    <View style={[styles.bar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.topRow}>
        <View style={[styles.dot, { backgroundColor: isRecording ? theme.danger : theme.textFaint }]} />
        <View style={styles.meter}>
          {bars.map((h, i) => (
            <View
              key={i}
              style={[styles.waveBar, { height: 4 + h * 20, backgroundColor: isRecording ? theme.accent : theme.surfaceMuted }]}
            />
          ))}
        </View>
        <Text variant="body" tone={interim ? 'default' : 'faint'} numberOfLines={1} style={styles.draft}>
          {interim || (isRecording ? t('meeting.live.listening') : t('meeting.paused'))}
        </Text>
      </View>

      <View style={styles.bottomRow}>
        <Text variant="caption" tone="faint" numberOfLines={1} style={{ flex: 1 }}>
          {t('meeting.live.autosendTo', { name: agentTitle })}
          {'  ·  '}{formatDuration(elapsedMs / 1000)}
          {sentCount > 0 ? `  ·  ${t('meeting.live.sent', { count: sentCount })}` : ''}
        </Text>

        <PressableScale
          onPress={() => (isRecording ? pause() : resume())}
          haptic
          scaleTo={0.94}
          style={[styles.ctrl, { backgroundColor: theme.surfaceMuted }]}
        >
          <Ionicons name={isRecording ? 'pause' : 'mic'} size={18} color={theme.text} />
          <Text variant="caption" tone="muted">{isRecording ? t('meeting.pause') : t('meeting.resume')}</Text>
        </PressableScale>

        <PressableScale
          onPress={end}
          haptic
          scaleTo={0.94}
          style={[styles.ctrl, { backgroundColor: theme.danger }]}
        >
          <Ionicons name="stop" size={18} color={theme.accentText} />
          <Text variant="caption" style={{ color: theme.accentText }}>{t('meeting.live.end')}</Text>
        </PressableScale>
      </View>
    </View>
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
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 24 },
  waveBar: { width: 3, borderRadius: 2 },
  draft: { flex: 1 },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ctrl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.pill,
  },
});
