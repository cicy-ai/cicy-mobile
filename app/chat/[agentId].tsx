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
import { HistoryView } from '@/src/components/HistoryView';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TerminalView } from '@/src/components/TerminalView';
import { Text } from '@/src/components/Text';
import { VoiceBar } from '@/src/components/VoiceBar';
import { api } from '@/src/api/http';
import { isTelegram, showBackButton } from '@/src/lib/telegram';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

// Voice input relies on native speech-recognition / audio recording, neither of
// which we wire up on web — so web defaults to (and stays in) text mode.
const IS_WEB = Platform.OS === 'web';

export default function Chat() {
  const { t } = useTranslation();
  const theme = useTheme();
  // Deep-link entry — this screen is the first content, drop the boot splash.
  useEffect(() => {
    dismissBootSplash();
  }, []);
  const { agentId: rawAgentId } = useLocalSearchParams<{ agentId: string }>();
  const agentId = String(rawAgentId);
  const { serverUrl, token } = useAuthStore();
  // Inside the Telegram Mini App we drop our own header and reuse Telegram's
  // native back button + title bar (saves vertical space).
  const inTg = isTelegram();
  useEffect(() => {
    if (!inTg) return;
    return showBackButton(() => router.back());
  }, [inTg]);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ text: string; nonce: number } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'voice' | 'text'>(IS_WEB ? 'text' : 'voice');
  // Track keyboard visibility for the small bottom-padding bump while typing.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardShown(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardShown(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // Tab + agent metadata. Both come from /api/panes — fetch once on entry.
  const [tab, setTab] = useState<'history' | 'cli'>('history');
  const [agentMeta, setAgentMeta] = useState<{
    title?: string;
    agentType?: string;
    status?: string;
    machineLabel?: string;
    useCustomGateway: boolean | null;
  }>({ useCustomGateway: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [panes, poll] = await Promise.all([
          api.getPanes().catch(() => []),
          api.poll().catch(() => ({ agents: [] })),
        ]);
        if (!alive) return;
        const pane = panes.find((p) => p.pane_id?.split(':')[0] === agentId);
        const agent = poll.agents?.find(
          (a: any) => (a.name || a.pane_id?.split(':')[0]) === agentId,
        );
        const useCustomGateway = pane?.use_custom_gateway === true;
        setAgentMeta({
          title: agent?.title || pane?.title,
          agentType: pane?.agent_type || agent?.agent_type,
          status: agent?.status,
          machineLabel: (pane as any)?.machine_label,
          useCustomGateway,
        });
      } catch {
        if (alive) setAgentMeta((m) => ({ ...m, useCustomGateway: null }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  const ttydUrl = useMemo(() => {
    if (!serverUrl || !token || !agentId) return null;
    return `${serverUrl}/ttyd/${encodeURIComponent(agentId)}/?token=${encodeURIComponent(token)}&mode=1`;
  }, [serverUrl, token, agentId]);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setVoiceError(null);
    setTab('history'); // make the instant feedback visible
    setPending({ text: trimmed, nonce: Date.now() }); // optimistic: show q now
    try {
      await api.sendToAgent(agentId, trimmed, true);
    } catch (e: any) {
      setPending(null); // failed → drop the optimistic q
      setVoiceError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await submit(text);
  };

  // Every agent can take pushed messages and serve history now, so always show
  // both tabs. We used to hide history (and default to the terminal) for
  // non-gateway claude-code-direct agents.
  const showTabs = true;
  const displayTitle = agentMeta.title || agentId;

  return (
    <Screen>
      {/* ─── Header: back / avatar + title. Hidden inside Telegram, which
          provides its own back button + title bar. ─── */}
      {!inTg && (
      <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn} hitSlop={6}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <AgentAvatar agentType={agentMeta.agentType} title={displayTitle} size={36} />
        <View style={styles.headerInfo}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {displayTitle}
          </Text>
          {agentMeta.machineLabel ? (
            <View style={styles.headerSubRow}>
              <Text variant="caption" tone="faint" numberOfLines={1}>
                {agentMeta.machineLabel}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      )}

      {/* ─── Tabs: only when both views are useful ─── */}
      {showTabs ? (
        <View style={[styles.tabBar, { borderBottomColor: theme.border }]}>
          {(['history', 'cli'] as const).map((tabName) => {
            const active = tab === tabName;
            const label = tabName === 'history' ? t('chat.tabHistory') : t('chat.tabCli');
            const icon = tabName === 'history' ? 'time-outline' : 'terminal-outline';
            return (
              <PressableScale
                key={tabName}
                onPress={() => setTab(tabName)}
                haptic={!active}
                scaleTo={0.97}
                style={styles.tabItem}
              >
                <Ionicons
                  name={icon as any}
                  size={16}
                  color={active ? theme.accent : theme.textMuted}
                  style={{ marginRight: 6 }}
                />
                <Text
                  variant="caption"
                  style={{
                    color: active ? theme.accent : theme.textMuted,
                    fontWeight: active ? '600' : '400',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  {label}
                </Text>
                {/* Underline appears under the active tab */}
                {active && (
                  <View
                    style={[styles.tabUnderline, { backgroundColor: theme.accent }]}
                    pointerEvents="none"
                  />
                )}
              </PressableScale>
            );
          })}
        </View>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        {tab === 'cli' ? (
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            {ttydUrl ? (
              <TerminalView url={ttydUrl} onLoadEnd={() => setLoaded(true)} />
            ) : (
              <View style={styles.loading}>
                <Text tone="muted">{t('chat.missingCreds')}</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={{ flex: 1, backgroundColor: theme.bg }}>
            <HistoryView agentId={agentId} pending={pending} />
          </View>
        )}

        {voiceError ? (
          <View style={[styles.errorRow, { backgroundColor: theme.bg, borderTopColor: theme.border }]}>
            <Text variant="caption" tone="danger" numberOfLines={2}>
              {voiceError}
            </Text>
            <PressableScale onPress={() => setVoiceError(null)} hitSlop={8}>
              <Ionicons name="close" size={16} color={theme.textMuted} />
            </PressableScale>
          </View>
        ) : null}

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
                onTranscript={(t) => submit(t)}
                onError={(m) => setVoiceError(m)}
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
                  autoFocus
                  style={[styles.input, typeScale.body, { color: theme.text }]}
                />
                <PressableScale
                  onPress={send}
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
                    <Ionicons
                      name="arrow-up"
                      size={18}
                      color={input.trim() ? theme.accentText : theme.textFaint}
                    />
                  )}
                </PressableScale>
              </View>
            )}

            {/* Mode toggle on the right — keypad in voice mode, mic in text mode.
                Hidden on web, which has no voice backend and stays in text mode. */}
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
  headerInfo: {
    flex: 1,
    gap: 2,
  },
  headerSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xl,
  },
  tabItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  tabUnderline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -StyleSheet.hairlineWidth,
    height: 2,
    borderRadius: 1,
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
  modeToggle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
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
});
