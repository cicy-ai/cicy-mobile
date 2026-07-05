import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';

import { AgentAvatar } from '@/src/components/AgentAvatar';
import { Composer } from '@/src/components/Composer';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TerminalView } from '@/src/components/TerminalView';
import { Text } from '@/src/components/Text';
import { api } from '@/src/api/http';
import { isTelegram, showBackButton } from '@/src/lib/telegram';
import { useAuthStore } from '@/src/store/auth';
import { spacing, useTheme } from '@/src/theme';

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

  // ── Composer state (same one-pill prompt area as the chat detail) ──
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {`${agentId} · ${t('chat.terminalTitle')}`}
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
            {/* Same one-pill composer as the chat detail (no attachments on
                the terminal — text and voice go straight to the CLI). */}
            <Composer
              value={input}
              onChangeText={setInput}
              onSubmit={() => void submit(input)}
              onTranscript={(txt) => void submit(txt)}
              onError={(m) => setError(m)}
              sending={sending}
            />
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
});
