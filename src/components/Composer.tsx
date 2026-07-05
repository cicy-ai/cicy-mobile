import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from './PressableScale';
import { RecordingDot } from './RecordingDot';
import { Text } from './Text';
import { useVoiceRecorder } from '@/src/hooks/useVoiceRecorder';
import {
  captureMedia, pickDocuments, pickImages, takePhoto, type PendingAttachment,
} from '@/src/lib/attachments';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

const IS_WEB = Platform.OS === 'web';

type Props = {
  /** Controlled text — the page owns it so it can restore on send failure. */
  value: string;
  onChangeText: (s: string) => void;
  /** Tap send / keyboard go. The page reads `value` itself. */
  onSubmit: () => void;
  /** Finalized voice transcript — sent directly, independent of `value`. */
  onTranscript: (text: string) => void;
  /** Enables the ⊕ sheet + camera button; picked media lands here. */
  onPickAttachments?: (atts: PendingAttachment[]) => void;
  onError?: (msg: string) => void;
  disabled?: boolean;
  sending?: boolean;
  /** Allow send with empty text (e.g. attachments staged above). */
  canSendEmpty?: boolean;
};

// One-pill composer, modeled on the reference shots:
//   text mode:  [ input ………………………… (voice) (+) ]   → typing swaps icons for a send button
//   voice mode: [ (camera)   按住说话   (kbd) (+) ]  → the center IS the push-to-talk zone
// Camera goes STRAIGHT to the system camera (photo + video); ⊕ opens the
// photo/album/file sheet. Web has no voice/camera stack → plain input + send.
export function Composer({
  value,
  onChangeText,
  onSubmit,
  onTranscript,
  onPickAttachments,
  onError,
  disabled,
  sending,
  canSendEmpty,
}: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<'text' | 'voice'>('text');
  const [sheetOpen, setSheetOpen] = useState(false);
  const { phase, start, stop, durationMs } = useVoiceRecorder({ onTranscript, onError });

  const isRecording = phase === 'recording';
  const isTranscribing = phase === 'transcribing';
  const hasText = value.trim().length > 0;
  const canAttach = !IS_WEB && !!onPickAttachments;
  const showVoice = !IS_WEB;

  async function runPick(fn: () => Promise<PendingAttachment[]>) {
    setSheetOpen(false);
    try {
      const atts = await fn();
      if (atts.length) onPickAttachments?.(atts);
    } catch (e: any) {
      onError?.(String(e?.message ?? e));
    }
  }

  const iconBtn = (
    name: string,
    onPress: () => void,
    opts?: { mc?: boolean; size?: number },
  ) => (
    <PressableScale onPress={onPress} disabled={disabled} haptic scaleTo={0.9} hitSlop={6} style={styles.iconBtn}>
      {opts?.mc ? (
        <MaterialCommunityIcons name={name as any} size={opts?.size ?? 24} color={theme.text} />
      ) : (
        <Ionicons name={name as any} size={opts?.size ?? 24} color={theme.text} />
      )}
    </PressableScale>
  );

  return (
    <>
      <View
        style={[
          styles.pill,
          {
            backgroundColor: isRecording ? theme.accent : theme.surface,
            borderColor: isRecording ? 'transparent' : theme.border,
          },
        ]}
      >
        {mode === 'voice' && showVoice ? (
          isRecording || isTranscribing ? (
            /* Recording / transcribing — the whole pill is the live zone. */
            <Pressable onPressOut={() => stop()} style={styles.holdZone}>
              {isRecording ? <RecordingDot color={theme.accentText} size={8} /> : null}
              <Text
                variant="bodyMedium"
                style={{ color: isRecording ? theme.accentText : theme.textMuted }}
              >
                {isTranscribing
                  ? t('voice.transcribing')
                  : `${t('voice.releaseToSend')}  ${formatDuration(durationMs / 1000)}`}
              </Text>
            </Pressable>
          ) : (
            <>
              {canAttach && iconBtn('camera-outline', () => void runPick(captureMedia))}
              <Pressable
                onPressIn={start}
                onPressOut={() => stop()}
                disabled={disabled}
                style={styles.holdZone}
              >
                <Text variant="bodyMedium">{t('voice.holdToTalk')}</Text>
              </Pressable>
              {iconBtn('keypad-outline', () => setMode('text'), { size: 22 })}
              {canAttach && iconBtn('add-circle-outline', () => setSheetOpen(true))}
            </>
          )
        ) : (
          <>
            <TextInput
              value={value}
              onChangeText={onChangeText}
              placeholder={showVoice ? t('chat.composerPlaceholder') : t('chat.messagePlaceholder')}
              placeholderTextColor={theme.textFaint}
              multiline
              editable={!disabled}
              style={[styles.input, typeScale.body, { color: theme.text }]}
            />
            {hasText || (canSendEmpty && !sending) ? (
              <PressableScale
                onPress={onSubmit}
                disabled={disabled || sending || (!hasText && !canSendEmpty)}
                haptic={!sending}
                style={[styles.send, { backgroundColor: theme.accent, opacity: sending ? 0.6 : 1 }]}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={theme.accentText} />
                ) : (
                  <Ionicons name="arrow-up" size={18} color={theme.accentText} />
                )}
              </PressableScale>
            ) : (
              <>
                {showVoice &&
                  iconBtn('account-voice', () => setMode('voice'), { mc: true, size: 22 })}
                {canAttach && iconBtn('add-circle-outline', () => setSheetOpen(true))}
              </>
            )}
          </>
        )}
      </View>

      {/* ⊕ sheet: photo / album / file (same trio as before). */}
      <Modal visible={sheetOpen} transparent animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setSheetOpen(false)}>
          <View
            style={[
              styles.sheet,
              { backgroundColor: theme.bg, borderColor: theme.border, paddingBottom: insets.bottom + spacing.md },
            ]}
          >
            {([
              ['camera-outline', t('attach.takePhoto'), takePhoto],
              ['image-outline', t('attach.pickImage'), pickImages],
              ['document-outline', t('attach.pickFile'), pickDocuments],
            ] as const).map(([icon, label, fn]) => (
              <PressableScale key={label} onPress={() => void runPick(fn)} scaleTo={0.98} style={styles.row}>
                <Ionicons name={icon as any} size={22} color={theme.text} />
                <Text variant="body">{label}</Text>
              </PressableScale>
            ))}
            <PressableScale onPress={() => setSheetOpen(false)} scaleTo={0.98} style={[styles.row, styles.cancel]}>
              <Text variant="bodyMedium" tone="muted">{t('attach.cancel')}</Text>
            </PressableScale>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

function formatDuration(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 48,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    paddingTop: spacing.sm + 1,
  },
  holdZone: {
    flex: 1,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  iconBtn: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  cancel: { justifyContent: 'center' },
});
