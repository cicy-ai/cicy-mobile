// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { useVoiceRecorder } from '@/src/hooks/useVoiceRecorder';
import {
  captureMedia, pickDocuments, pickImages, type PendingAttachment,
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
  /** Reply in flight → the ⊕ attach button becomes a stop (icon-only). */
  busy?: boolean;
  onStop?: () => void;
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
  busy,
  onStop,
}: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Voice-first on native (按住说话 is the default prompt); web has no voice
  // stack and stays in text mode.
  const [mode, setMode] = useState<'text' | 'voice'>(IS_WEB ? 'text' : 'voice');
  const inputRef = useRef<TextInput>(null);
  // Tapping the ⌨ (voice→text) should immediately raise the keyboard, not just
  // swap the UI. Focus once the TextInput is mounted for this mode. Skip the
  // initial web mount (mode starts 'text' there and auto-focusing steals focus).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (mode === 'text') {
      // rAF: let the TextInput commit for this render before focusing.
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [mode]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { phase, start, stop } = useVoiceRecorder({ onTranscript, onError });

  const isRecording = phase === 'recording';
  const isTranscribing = phase === 'transcribing';
  const hasText = value.trim().length > 0;
  // Attach works on web too: expo-image-picker / expo-document-picker fall back
  // to a native <input type=file> in the browser. (Was gated off with !IS_WEB.)
  const canAttach = !!onPickAttachments;
  // Voice hold-to-talk stays native-only: it needs expo-audio recording +
  // expo-speech-recognition, neither of which has a web implementation. Enabling
  // it on web would render a mic UI whose recorder throws. A web voice path would
  // be a separate MediaRecorder + Web Speech API build.
  const showVoice = !IS_WEB;

  // Slide-up-to-cancel (per the reference shots): while holding, moving the
  // finger up past the threshold flips the pill red and the release cancels.
  const [cancelIntent, setCancelIntent] = useState(false);
  const cancelIntentRef = useRef(false);
  const touchStartYRef = useRef(0);
  const CANCEL_DY = 60;
  const onHoldStart = (e: GestureResponderEvent) => {
    touchStartYRef.current = e.nativeEvent.pageY;
    cancelIntentRef.current = false;
    setCancelIntent(false);
    void start();
  };
  const onHoldMove = (e: GestureResponderEvent) => {
    // Track intent for the whole hold (responder fires move only between
    // grant→release, so this is inherently scoped to the press). No phase gate:
    // a fast slide-up before recording finishes starting must still cancel.
    const up = touchStartYRef.current - e.nativeEvent.pageY;
    const intent = up > CANCEL_DY;
    if (intent !== cancelIntentRef.current) {
      cancelIntentRef.current = intent;
      setCancelIntent(intent);
    }
  };
  const onHoldEnd = () => {
    const cancel = cancelIntentRef.current;
    cancelIntentRef.current = false;
    setCancelIntent(false);
    void stop({ cancel });
  };

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

  // While a reply is streaming, the ⊕ attach slot becomes a stop button
  // (icon-only) — no separate row above the composer. Idle → the ⊕ attach.
  const attachOrStop = () => {
    if (busy && onStop) {
      return (
        <PressableScale
          onPress={onStop}
          haptic
          scaleTo={0.9}
          hitSlop={6}
          style={styles.iconBtn}
          accessibilityLabel={t('chat.stop')}
        >
          <Ionicons name="stop-circle" size={26} color={theme.danger} />
        </PressableScale>
      );
    }
    return canAttach ? iconBtn('add-circle-outline', () => setSheetOpen(true)) : null;
  };

  const recordingBg = cancelIntent ? theme.danger : theme.accent;

  return (
    <View style={styles.wrap}>
      {/* Hint floats above the pill while recording (reference design). */}
      {isRecording && (
        <Text
          variant="caption"
          style={[styles.recordHint, { color: cancelIntent ? theme.danger : theme.textMuted }]}
        >
          {cancelIntent ? t('voice.releaseToCancel') : t('voice.slideUpCancelHint')}
        </Text>
      )}
      <View
        style={[
          styles.pill,
          {
            backgroundColor: isRecording ? recordingBg : theme.surface,
            borderColor: isRecording ? 'transparent' : theme.border,
          },
        ]}
      >
        {mode === 'voice' && showVoice ? (
          <>
            {/* Side icons hide while recording — the pill becomes pure waveform. */}
            {!isRecording && !isTranscribing && canAttach &&
              iconBtn('camera-outline', () => void runPick(captureMedia))}
            {/* ONE always-mounted hold zone driven by the RAW responder system —
                NOT Pressable. Pressable's onTouchMove is unreliable (Pressability
                swallows move events), so slide-up-to-cancel never fired. The
                responder handlers (grant/move/release/terminate) deliver every
                move with pageY, so the upward-travel intent is tracked precisely. */}
            <View
              onStartShouldSetResponder={() => !(disabled || isTranscribing)}
              onMoveShouldSetResponder={() => !(disabled || isTranscribing)}
              onResponderGrant={onHoldStart}
              onResponderMove={onHoldMove}
              onResponderRelease={onHoldEnd}
              onResponderTerminate={onHoldEnd}
              style={styles.holdZone}
            >
              {isRecording ? (
                <Waveform color={theme.accentText} paused={cancelIntent} />
              ) : (
                <Text variant="bodyMedium" tone={isTranscribing ? 'muted' : 'default'}>
                  {isTranscribing ? t('voice.transcribing') : t('voice.holdToTalk')}
                </Text>
              )}
            </View>
            {!isRecording && !isTranscribing && (
              <>
                {iconBtn('keypad-outline', () => setMode('text'), { size: 22 })}
                {attachOrStop()}
              </>
            )}
          </>
        ) : (
          <>
            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={onChangeText}
              placeholder={showVoice ? t('chat.composerPlaceholder') : t('chat.messagePlaceholder')}
              placeholderTextColor={theme.textFaint}
              multiline
              // RN-Web renders a multiline TextInput as a <textarea>; with no
              // rows it defaults to ~2 lines, so the empty composer is too tall
              // on web (native auto-sizes to 1 line and is fine). Pin rows=1 on
              // web ONLY — on native numberOfLines can CAP visible lines, which
              // we must not do. maxHeight:140 still caps growth on both.
              {...(IS_WEB ? { numberOfLines: 1 } : {})}
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
                {attachOrStop()}
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
            {/* No 拍照 here — the dedicated camera button already opens the
                camera directly. ⊕ is only 相册 + 文件, so 拍照 isn't duplicated. */}
            {([
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
    </View>
  );
}

// Animated fake waveform (reference look): a row of thin rounded bars whose
// heights re-randomize on a short interval. Real mic metering isn't exposed
// uniformly by both speech backends, and the visual is what matters here.
const WAVE_BARS = 34;
function Waveform({ color, paused }: { color: string; paused?: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (paused) return; // slide-up-to-cancel → freeze the bars (stop the pulse)
    const iv = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(iv);
  }, [paused]);
  const bars = [];
  for (let i = 0; i < WAVE_BARS; i += 1) {
    // center-weighted pseudo-random heights, reshuffled by `tick`
    const seed = Math.sin(i * 12.9898 + tick * 78.233) * 43758.5453;
    const rnd = seed - Math.floor(seed);
    const centerBoost = 1 - Math.abs(i - WAVE_BARS / 2) / (WAVE_BARS / 2);
    const h = 4 + Math.round(rnd * 10 * (0.5 + centerBoost));
    bars.push(<View key={i} style={[styles.waveBar, { height: h, backgroundColor: color }]} />);
  }
  return <View style={styles.wave}>{bars}</View>;
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  recordHint: {
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  wave: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: 24,
  },
  waveBar: {
    width: 3,
    borderRadius: 2,
  },
  pill: {
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
