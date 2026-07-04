import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AgentAvatar } from '@/src/components/AgentAvatar';
import { AttachButton } from '@/src/components/AttachButton';
import { HistoryView } from '@/src/components/HistoryView';
import { LiveRecordBar } from '@/src/components/LiveRecordBar';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TerminalView } from '@/src/components/TerminalView';
import { Text } from '@/src/components/Text';
import { VoiceBar } from '@/src/components/VoiceBar';
import { api } from '@/src/api/http';
import { uploadAttachment } from '@/src/api/upload';
import type { PendingAttachment } from '@/src/lib/attachments';
import { normalizeAgentType } from '@/src/lib/agentType';
import { isTelegram, showBackButton } from '@/src/lib/telegram';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { useShareStore } from '@/src/store/share';
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
  // Content shared in from outside (share sheet / PWA share target): prefill
  // the composer once — the user reviews and hits send themselves.
  useEffect(() => {
    const shared = useShareStore.getState().consume();
    if (shared) setInput((prev) => (prev.trim() ? prev + '\n' + shared : shared));
  }, [agentId]);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<{ text: string; nonce: number } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  // True until the first turn of a live session is sent — that first turn is
  // prefixed with a "you are a meeting assistant" instruction for the agent.
  const meetingPrimedRef = useRef(false);
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
    const atts = attachments;
    if (!text && atts.length === 0) return;
    if (sending) return;
    setInput('');
    setAttachments([]);
    setSending(true);
    setVoiceError(null);

    try {
      let body = text;
      if (atts.length) {
        // Upload each attachment into the agent's workspace, then reference the
        // returned (cwd-relative) paths so the CLI agent can read them.
        const uploaded: string[] = [];
        const failed: PendingAttachment[] = [];
        for (const a of atts) {
          try {
            const r = await uploadAttachment(agentId, a.uri, a.name, a.mime);
            uploaded.push(r.path);
          } catch {
            failed.push(a);
          }
        }
        if (failed.length) {
          setAttachments((cur) => [...failed, ...cur]); // keep for retry
          setVoiceError(t('attach.uploadFailed', { count: failed.length }));
        }
        if (uploaded.length) {
          const list = uploaded.map((p) => `- ${p}`).join('\n');
          body = `${text ? `${text}\n\n` : ''}${t('attach.agentNote')}\n${list}`;
        } else if (!text) {
          setSending(false);
          return; // nothing uploaded and no text — abort
        }
      }

      setTab('history');
      setPending({ text: body, nonce: Date.now() });
      await api.sendToAgent(agentId, body, true);
    } catch (e: any) {
      setPending(null);
      setVoiceError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
    } finally {
      setSending(false);
    }
  };

  const removeAttachment = (key: string) =>
    setAttachments((cur) => cur.filter((a) => a.key !== key));

  // Each finalized live-recording turn → send to the agent. The first turn of a
  // session is prefixed so the agent knows to act as a quiet meeting recorder.
  const handleLiveTurn = (text: string) => {
    if (!meetingPrimedRef.current) {
      meetingPrimedRef.current = true;
      submit(`${t('meeting.assistantPrime')}\n\n${text}`);
    } else {
      submit(text);
    }
  };

  const startRecording = () => {
    meetingPrimedRef.current = false;
    Keyboard.dismiss();
    setRecording(true);
  };

  // cicy-type agents run without an attached terminal (no ttyd), so the CLI tab
  // has nothing to show — hide it and stay history-only. Every other agent shows
  // both the history + terminal tabs.
  const hasTerminal = normalizeAgentType(agentMeta.agentType) !== 'cicy-claude';
  const showTabs = hasTerminal;
  const activeTab = hasTerminal ? tab : 'history';
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
        {activeTab === 'cli' ? (
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
          {recording ? (
            <LiveRecordBar
              agentTitle={displayTitle}
              onTurn={handleLiveTurn}
              onClose={() => setRecording(false)}
              onError={(m) => setVoiceError(m)}
            />
          ) : (
          <>
          {attachments.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.chipsRow}
            >
              {attachments.map((a) => (
                <View key={a.key} style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  {a.kind === 'image' ? (
                    <Image source={{ uri: a.uri }} style={styles.chipThumb} />
                  ) : (
                    <Ionicons name="document-outline" size={18} color={theme.textMuted} />
                  )}
                  <Text variant="caption" numberOfLines={1} style={styles.chipName}>
                    {a.name}
                  </Text>
                  <PressableScale onPress={() => removeAttachment(a.key)} hitSlop={6} scaleTo={0.9}>
                    <Ionicons name="close-circle" size={16} color={theme.textMuted} />
                  </PressableScale>
                </View>
              ))}
            </ScrollView>
          )}

          <View style={styles.composerRow}>
            {!IS_WEB && (
              <AttachButton
                onPick={(atts) => setAttachments((cur) => [...cur, ...atts])}
                onError={(m) => setVoiceError(m)}
                disabled={sending}
              />
            )}
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
                  disabled={sending || (!input.trim() && attachments.length === 0)}
                  haptic={!sending && (!!input.trim() || attachments.length > 0)}
                  style={[
                    styles.send,
                    {
                      backgroundColor:
                        input.trim() || attachments.length > 0 ? theme.accent : theme.surfaceMuted,
                      opacity: sending ? 0.6 : 1,
                    },
                  ]}
                >
                  {sending ? (
                    <ActivityIndicator
                      size="small"
                      color={input.trim() || attachments.length > 0 ? theme.accentText : theme.textFaint}
                    />
                  ) : (
                    <Ionicons
                      name="arrow-up"
                      size={18}
                      color={input.trim() || attachments.length > 0 ? theme.accentText : theme.textFaint}
                    />
                  )}
                </PressableScale>
              </View>
            )}

            {/* Live recording — continuous on-device dictation that auto-sends
                each turn to the agent (the in-conversation meeting assistant). */}
            {!IS_WEB && (
              <PressableScale
                onPress={startRecording}
                haptic
                scaleTo={0.94}
                disabled={sending}
                style={[styles.modeToggle, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <MaterialCommunityIcons name="account-voice" size={22} color={theme.text} />
              </PressableScale>
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
          </>
          )}
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
  chipsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    paddingLeft: 6,
    paddingRight: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipThumb: {
    width: 28,
    height: 28,
    borderRadius: 6,
  },
  chipName: {
    flexShrink: 1,
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
