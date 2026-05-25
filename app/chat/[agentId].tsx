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
import { WebView } from 'react-native-webview';

import { AgentAvatar } from '@/src/components/AgentAvatar';
import { HistoryView } from '@/src/components/HistoryView';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { VoiceBar } from '@/src/components/VoiceBar';
import { api } from '@/src/api/http';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

type StatusTone = 'ok' | 'warn' | 'busy' | 'muted';

function classifyStatus(status?: string): StatusTone {
  const s = (status || '').toLowerCase();
  if (s.includes('think') || s.includes('streaming') || s.includes('busy')) return 'busy';
  if (s.includes('error') || s.includes('fail')) return 'warn';
  if (s === 'idle' || !s) return 'ok';
  return 'muted';
}

export default function Chat() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { agentId: rawAgentId } = useLocalSearchParams<{ agentId: string }>();
  const agentId = String(rawAgentId);
  const { serverUrl, token } = useAuthStore();

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
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
        if (!useCustomGateway) setTab('cli');
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
    try {
      await api.sendToAgent(agentId, trimmed, true);
    } catch (e: any) {
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

  const status = agentMeta.status;
  const tone = classifyStatus(status);
  const statusColor =
    tone === 'busy' ? theme.warn : tone === 'warn' ? theme.danger : tone === 'ok' ? theme.ok : theme.textMuted;
  const showTabs = agentMeta.useCustomGateway !== false;
  const displayTitle = agentMeta.title || agentId;

  return (
    <Screen>
      {/* ─── Header: back / avatar + title + status pill / spacer ─── */}
      <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn} hitSlop={6}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <AgentAvatar agentType={agentMeta.agentType} title={displayTitle} size={36} />
        <View style={styles.headerInfo}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {displayTitle}
          </Text>
          <View style={styles.headerSubRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {status || t('chat.statusUnknown')}
            </Text>
            {agentMeta.machineLabel ? (
              <>
                <Text variant="caption" tone="faint">·</Text>
                <Text variant="caption" tone="faint" numberOfLines={1}>
                  {agentMeta.machineLabel}
                </Text>
              </>
            ) : null}
          </View>
        </View>
      </View>

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
              <WebView
                source={{ uri: ttydUrl }}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                onLoadEnd={() => setLoaded(true)}
                startInLoadingState
                injectedJavaScriptBeforeContentLoaded={MOBILE_VIEWPORT_INJECT}
                injectedJavaScript={MOBILE_XTERM_INJECT}
                renderLoading={() => (
                  <View style={styles.loading}>
                    <ActivityIndicator color={theme.textMuted} />
                  </View>
                )}
                style={{ flex: 1, backgroundColor: '#000' }}
              />
            ) : (
              <View style={styles.loading}>
                <Text tone="muted">{t('chat.missingCreds')}</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={{ flex: 1, backgroundColor: theme.bg }}>
            <HistoryView agentId={agentId} />
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

            {/* Mode toggle on the right — keypad in voice mode, mic in text mode. */}
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
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const MOBILE_VIEWPORT_INJECT = `
  (function(){
    var existing = document.querySelector('meta[name="viewport"]');
    if (existing) existing.remove();
    var m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    (document.head || document.documentElement).appendChild(m);
  })();
  true;
`;

const MOBILE_XTERM_INJECT = `
  (function(){
    var FONT_SIZE = 12;
    var LINE_HEIGHT = 1.15;
    var FONT_FAMILY = 'Menlo, "SF Mono", Consolas, monospace';
    var tries = 0;
    function looksLikeTerm(t){
      return t && typeof t === 'object' && t.options && typeof t.resize === 'function';
    }
    function findTerm(){
      if (looksLikeTerm(window.term)) return window.term;
      if (window.tty && looksLikeTerm(window.tty.term)) return window.tty.term;
      if (window.terminal && looksLikeTerm(window.terminal)) return window.terminal;
      return null;
    }
    function findFit(){
      if (window.fitAddon && typeof window.fitAddon.fit === 'function') return window.fitAddon;
      return null;
    }
    function tune(){
      var t = findTerm();
      if (!t) return false;
      try {
        if (t.options) {
          t.options.fontSize = FONT_SIZE;
          t.options.lineHeight = LINE_HEIGHT;
          t.options.fontFamily = FONT_FAMILY;
        } else {
          t.setOption && t.setOption('fontSize', FONT_SIZE);
          t.setOption && t.setOption('lineHeight', LINE_HEIGHT);
          t.setOption && t.setOption('fontFamily', FONT_FAMILY);
        }
        var fit = findFit();
        if (fit) {
          fit.fit();
        } else if (typeof t.fit === 'function') {
          t.fit();
        }
        document.documentElement.style.background = '#000';
        document.body && (document.body.style.background = '#000');
        return true;
      } catch (e) {
        return false;
      }
    }
    function loop(){
      if (tune() || tries++ > 30) return;
      setTimeout(loop, 250);
    }
    if (document.readyState === 'complete') loop();
    else window.addEventListener('load', loop);
    window.addEventListener('resize', function(){ setTimeout(tune, 100); });
  })();
  true;
`;

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
