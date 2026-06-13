import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { useMeetingTranscriber } from '@/src/hooks/useMeetingTranscriber';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  open: boolean;
  onClose: () => void;
  // Send the meeting transcript to the agent. Returns once dispatched.
  onSend: (text: string) => void;
  onError?: (msg: string) => void;
  language?: string;
};

// Full-screen real-time meeting transcription. Native on-device recognizer runs
// continuously; the text streams in live and can be sent to the agent in one
// shot. Foreground-only (we hold a keep-awake lock while recording).
export function MeetingPanel({ open, onClose, onSend, onError, language }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);

  const {
    phase, committed, interim, transcript, level, elapsedMs,
    start, pause, resume, stop, clear,
  } = useMeetingTranscriber({ language, onError });

  const isRecording = phase === 'recording';
  const isPaused = phase === 'paused';
  const hasText = transcript.length > 0;

  async function handleSend() {
    if (!hasText) return;
    if (phase !== 'idle') await stop();
    onSend(transcript);
    clear();
    onClose();
  }

  async function handleClose() {
    if (phase !== 'idle') await stop();
    onClose();
  }

  async function handleCopy() {
    if (!hasText) return;
    await Clipboard.setStringAsync(transcript).catch(() => {});
  }

  // 5-bar level meter; the center bars react most to the live volume.
  const bars = [0.4, 0.7, 1, 0.7, 0.4].map((w) => Math.max(0.12, level * w));

  return (
    <Modal visible={open} animationType="slide" onRequestClose={handleClose} transparent={false}>
      <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <View style={styles.headerTitle}>
            <MaterialCommunityIcons name="account-voice" size={22} color={theme.accent} />
            <Text variant="bodyMedium">{t('meeting.title')}</Text>
          </View>
          <PressableScale onPress={handleClose} hitSlop={8} scaleTo={0.92}>
            <Ionicons name="close" size={24} color={theme.textMuted} />
          </PressableScale>
        </View>

        {/* Transcript */}
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {hasText ? (
            <Text variant="body" style={{ lineHeight: 26 }}>
              {committed}
              {interim ? (
                <Text variant="body" style={{ color: theme.textFaint }}>
                  {committed ? ' ' : ''}{interim}
                </Text>
              ) : null}
            </Text>
          ) : (
            <View style={styles.empty}>
              <Text tone="faint" variant="callout" style={{ textAlign: 'center' }}>
                {t('meeting.emptyHint')}
              </Text>
            </View>
          )}
        </ScrollView>

        {/* Footer: level + timer + controls */}
        <View style={[styles.footer, { borderTopColor: theme.border, paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.meterRow}>
            <View style={styles.meter}>
              {bars.map((h, i) => (
                <View
                  key={i}
                  style={[
                    styles.bar,
                    {
                      height: 6 + h * 26,
                      backgroundColor: isRecording ? theme.accent : theme.surfaceMuted,
                    },
                  ]}
                />
              ))}
            </View>
            <Text variant="caption" tone={isRecording ? 'default' : 'faint'}>
              {isRecording ? t('meeting.listening') : isPaused ? t('meeting.paused') : t('meeting.idle')}
              {'  '}{formatDuration(elapsedMs / 1000)}
            </Text>
          </View>

          {/* Primary transport row */}
          <View style={styles.controls}>
            {phase === 'idle' ? (
              <PrimaryBtn icon="mic" label={t('meeting.start')} color={theme.accent} fg={theme.accentText} onPress={start} />
            ) : isRecording ? (
              <>
                <PrimaryBtn icon="pause" label={t('meeting.pause')} color={theme.surfaceMuted} fg={theme.text} onPress={pause} />
                <PrimaryBtn icon="stop" label={t('meeting.stop')} color={theme.danger} fg={theme.accentText} onPress={stop} />
              </>
            ) : (
              <>
                <PrimaryBtn icon="mic" label={t('meeting.resume')} color={theme.accent} fg={theme.accentText} onPress={resume} />
                <PrimaryBtn icon="stop" label={t('meeting.stop')} color={theme.danger} fg={theme.accentText} onPress={stop} />
              </>
            )}
          </View>

          {/* Secondary row: copy / clear / send */}
          <View style={styles.controls}>
            <SecondaryBtn icon="copy-outline" label={t('meeting.copy')} disabled={!hasText} onPress={handleCopy} />
            <SecondaryBtn icon="trash-outline" label={t('meeting.clear')} disabled={!hasText} onPress={clear} />
            <PressableScale
              onPress={handleSend}
              disabled={!hasText}
              haptic={hasText}
              scaleTo={0.96}
              style={[
                styles.sendBtn,
                { backgroundColor: hasText ? theme.accent : theme.surfaceMuted, opacity: hasText ? 1 : 0.6 },
              ]}
            >
              <Ionicons name="arrow-up" size={18} color={hasText ? theme.accentText : theme.textFaint} />
              <Text variant="bodyMedium" style={{ color: hasText ? theme.accentText : theme.textFaint }}>
                {t('meeting.send')}
              </Text>
            </PressableScale>
          </View>

          <Text variant="caption" tone="faint" style={{ textAlign: 'center', marginTop: spacing.sm }}>
            {t('meeting.foregroundHint')}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

function PrimaryBtn({
  icon, label, color, fg, onPress,
}: { icon: any; label: string; color: string; fg: string; onPress: () => void }) {
  return (
    <PressableScale onPress={onPress} haptic scaleTo={0.96} style={[styles.primaryBtn, { backgroundColor: color }]}>
      <Ionicons name={icon} size={20} color={fg} />
      <Text variant="bodyMedium" style={{ color: fg }}>{label}</Text>
    </PressableScale>
  );
}

function SecondaryBtn({
  icon, label, disabled, onPress,
}: { icon: any; label: string; disabled?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      scaleTo={0.96}
      style={[styles.secondaryBtn, { borderColor: theme.border, opacity: disabled ? 0.4 : 1 }]}
    >
      <Ionicons name={icon} size={18} color={theme.textMuted} />
      <Text variant="caption" tone="muted">{label}</Text>
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
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.xl, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  meterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 34 },
  bar: { width: 4, borderRadius: 2 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  primaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 48,
    borderRadius: radius.pill,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    height: 40,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    height: 40,
    borderRadius: radius.pill,
  },
});
