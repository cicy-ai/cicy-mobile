import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';

import { HistoryView } from '@/src/components/HistoryView';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { StatusDot } from '@/src/components/StatusDot';
import { Text } from '@/src/components/Text';
import { VoiceBar } from '@/src/components/VoiceBar';
import { api } from '@/src/api/http';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

export default function Chat() {
  const theme = useTheme();
  const { agentId: rawAgentId } = useLocalSearchParams<{ agentId: string }>();
  const agentId = String(rawAgentId);
  const { serverUrl, token } = useAuthStore();

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  // Detail tab: 'history' (structured turns) vs 'cli' (live ttyd terminal).
  // useCustomGateway === false → agent talks to anthropic.com directly, no
  // turns recorded, no point showing the History tab at all.
  const [useCustomGateway, setUseCustomGateway] = useState<boolean | null>(null);
  const [tab, setTab] = useState<'history' | 'cli'>('history');

  // Fetch /api/panes once on entry to learn the gateway flag for this agent.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const panes = await api.getPanes();
        if (!alive) return;
        const match = panes.find((p) => p.pane_id?.split(':')[0] === agentId);
        const flag = !!match?.use_custom_gateway;
        setUseCustomGateway(flag);
        if (!flag) setTab('cli'); // History is useless for non-gateway agents.
      } catch {
        if (alive) setUseCustomGateway(null); // unknown — assume both tabs OK
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  // ttyd URL — same shape the web UI uses (see app/src/config.ts:130).
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
      setVoiceError(`Send failed: ${String(e?.message ?? e)}`);
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

  return (
    // No Stack header — we draw our own minimal nav row below. Stack's header
    // forces react-native-screens to add bottom safe-area padding to the
    // screen content, which painted a cream strip under the composer.
    <Screen>
      <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <View style={styles.headerTitle}>
          <StatusDot tone={loaded ? 'ok' : 'warn'} pulse={!loaded} />
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {agentId}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        {useCustomGateway !== false ? (
          <View style={[styles.tabRow, { backgroundColor: theme.surfaceMuted }]}>
            {(['history', 'cli'] as const).map((tabName) => (
              <PressableScale
                key={tabName}
                onPress={() => setTab(tabName)}
                haptic={tab !== tabName}
                scaleTo={0.96}
                style={[
                  styles.tabChip,
                  tab === tabName && { backgroundColor: theme.surface },
                ]}
              >
                <Text
                  variant="caption"
                  tone={tab === tabName ? 'default' : 'muted'}
                  style={{ textTransform: 'uppercase' }}
                >
                  {tabName}
                </Text>
              </PressableScale>
            ))}
          </View>
        ) : null}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        // The KAV already starts below the status header, so no vertical offset
        // is needed. `padding` on both platforms reliably lifts the composer;
        // Android's adjustResize can be flaky in edge-to-edge mode.
        behavior="padding"
        keyboardVerticalOffset={0}
      >
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
                <Text tone="muted">missing server or token</Text>
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
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              backgroundColor: theme.bg,
              borderTopColor: theme.border,
              // No bottom inset padding — Stack screen content already lives
              // above the system nav, and adding insets.bottom on top left a
              // visible cream gap below the talk button. Just the visual
              // breathing room from the stylesheet's `paddingBottom`.
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
                  placeholder="Message…"
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
                  <Text
                    style={{
                      color: input.trim() ? theme.accentText : theme.textFaint,
                      fontSize: 18,
                      lineHeight: 18,
                    }}
                  >
                    ↑
                  </Text>
                </PressableScale>
              </View>
            )}

            {/* Mode toggle sits to the RIGHT of the input/voice bar. Keypad
                glyph when in voice mode (tap → switch to typing); broadcast
                arc-fan glyph when in text mode (tap → switch to voice). */}
            <PressableScale
              onPress={() => setMode((m) => (m === 'voice' ? 'text' : 'voice'))}
              haptic
              scaleTo={0.94}
              style={[styles.modeToggle, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              {mode === 'voice' ? (
                <Ionicons name="keypad-outline" size={20} color={theme.text} />
              ) : (
                <MaterialCommunityIcons name="broadcast" size={22} color={theme.text} />
              )}
            </PressableScale>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function hostLabel(serverUrl: string | null): string {
  if (!serverUrl) return '';
  return serverUrl.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
}

// Force a phone-friendly viewport. Runs before the page's own scripts so the
// xterm renderer measures the right pixel width on first paint instead of
// re-flowing later.
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

// Hunt down the xterm Terminal instance, shrink fonts for mobile, and re-fit.
// ttyd exposes the terminal on window.term in current builds; if that changes
// we still try every Terminal-shaped object we can find. Idempotent and retries
// because the terminal can be constructed after page load on slow networks.
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
    // Re-fit on orientation change / keyboard show.
    window.addEventListener('resize', function(){ setTimeout(tune, 100); });
  })();
  true;
`;

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: spacing.sm,
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
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tabRow: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: radius.pill,
    gap: 2,
  },
  tabChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorRow: {
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
