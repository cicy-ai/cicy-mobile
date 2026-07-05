import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AgentAvatar } from '@/src/components/AgentAvatar';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TerminalView } from '@/src/components/TerminalView';
import { Text } from '@/src/components/Text';
import { VoiceBar } from '@/src/components/VoiceBar';
import { api } from '@/src/api/http';
import { isTelegram, showBackButton } from '@/src/lib/telegram';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

const IS_WEB = Platform.OS === 'web';

// Full-screen live terminal (the team server's gotty page for this agent's
// pane) with the same prompt area as the chat detail below it. Typing happens
// in this NATIVE composer — the keyboard lifts the composer, and although the
// webview above shrinks, the terminal inside is pinned to fixed pixels (see
// TerminalView) so nothing reflows.
export default function Terminal() {
  const { t } = useTranslation();
  const theme = useTheme();
  const params = useLocalSearchParams<{ agentId: string; title?: string; agentType?: string }>();
  const agentId = String(params.agentId);
  const displayTitle = params.title || agentId;
  const { serverUrl, token } = useAuthStore();

  const inTg = isTelegram();
  useEffect(() => {
    if (!inTg) return;
    return showBackButton(() => router.back());
  }, [inTg]);

  const url = useMemo(() => {
    if (!serverUrl || !token || !agentId) return null;
    return `${serverUrl}/ttyd/${encodeURIComponent(agentId)}/?token=${encodeURIComponent(token)}&mode=1`;
  }, [serverUrl, token, agentId]);

  // ── Composer state (subset of the chat detail's prompt area) ──
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'voice' | 'text'>(IS_WEB ? 'text' : 'voice');
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardShown(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardShown(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendToAgent(agentId, trimmed, true);
      setInput('');
    } catch (e: any) {
      setError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      {!inTg && (
        <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
          <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn} hitSlop={6}>
            <Ionicons name="chevron-back" size={26} color={theme.text} />
          </PressableScale>
          <AgentAvatar agentType={params.agentType} title={displayTitle} size={32} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" numberOfLines={1}>
              {displayTitle}
            </Text>
            <Text variant="caption" tone="faint">
              {t('chat.terminalTitle')}
            </Text>
          </View>
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        {/* The webview may shrink when the keyboard lifts the composer — safe,
            because #terminal inside is pinned to fixed pixels and never
            refits (no resize ever reaches the shared tmux window). */}
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {url ? (
            <TerminalView url={url} />
          ) : (
            <View style={styles.loading}>
              <Text tone="muted">{t('chat.missingCreds')}</Text>
            </View>
          )}
        </View>

        {error ? (
          <View style={[styles.errorRow, { backgroundColor: theme.bg, borderTopColor: theme.border }]}>
            <Text variant="caption" tone="danger" numberOfLines={2}>
              {error}
            </Text>
            <PressableScale onPress={() => setError(null)} hitSlop={8}>
              <Ionicons name="close" size={16} color={theme.textMuted} />
            </PressableScale>
          </View>
        ) : null}

        {/* ── Prompt area — mirrors the chat detail composer ── */}
        <View
          style={[
            styles.composer,
            {
              backgroundColor: theme.bg,
              borderTopColor: theme.border,
              paddingBottom: keyboardShown
                ? (Platform.OS === 'ios' ? 45 : spacing.lg + 18)
                : spacing.lg,
            },
          ]}
        >
          <View style={styles.composerRow}>
            {mode === 'voice' ? (
              <VoiceBar
                onTranscript={(txt) => submit(txt)}
                onError={(m) => setError(m)}
                disabled={sending}
              />
            ) : (
              <View
                style={[
                  styles.textInputInner,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ]}
              >
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder={t('chat.messagePlaceholder')}
                  placeholderTextColor={theme.textFaint}
                  multiline
                  style={[styles.input, typeScale.body, { color: theme.text }]}
                />
                <PressableScale
                  onPress={() => void submit(input)}
                  disabled={sending || !input.trim()}
                  haptic={!sending && !!input.trim()}
                  style={[
                    styles.send,
                    {
                      backgroundColor: input.trim() ? theme.accent : theme.surfaceMuted,
                      opacity: sending ? 0.6 : 1,
                    },
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={input.trim() ? theme.accentText : theme.textFaint} />
                  ) : (
                    <Ionicons name="arrow-up" size={18} color={input.trim() ? theme.accentText : theme.textFaint} />
                  )}
                </PressableScale>
              </View>
            )}

            {!IS_WEB && (
              <PressableScale
                onPress={() => {
                  setMode((m) => (m === 'voice' ? 'text' : 'voice'));
                  if (mode === 'text') Keyboard.dismiss();
                }}
                haptic
                scaleTo={0.94}
                style={[styles.modeToggle, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                {mode === 'voice' ? (
                  <Ionicons name="keypad-outline" size={20} color={theme.text} />
                ) : (
                  <MaterialCommunityIcons name="microphone-outline" size={22} color={theme.text} />
                )}
              </PressableScale>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.xs,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  textInputInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: radius.xl,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 140,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    paddingTop: spacing.sm + 2,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeToggle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
