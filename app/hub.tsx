// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The Hub screen. A Hub is one scanned WS connection (HubWsClient) reaching the
// hub. Two layouts:
//   • phone (narrow): ONE big chat with the fleet coordinator (协调官) + a ☰
//     org/teams drawer. Simple single conversation.
//   • pad/desktop (wide): a two-pane master-detail — left = the hub's reachable
//     agents (coordinator first), right = the chat with the selected agent.
// The chat reuses the SAME two-part engine the team chat uses (HistoryView +
// useCurrentHistory), pointed at the agent's `reach_url` and authenticated with
// OUR hubToken via `?token=` (per w-10122's security model: no per-agent token,
// api_token is 401 on the public net). See cicy-hub/docs/mobile-integration.md.

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Keyboard,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createApi, type Endpoint } from '@/src/api/http';
import { HubWsClient, type HubAgent, type HubWsStatus } from '@/src/api/hubws';
import { uploadAttachment } from '@/src/api/upload';
import { AgentAvatar } from '@/src/components/AgentAvatar';
import { Button } from '@/src/components/Button';
import { Composer } from '@/src/components/Composer';
import { HistoryView } from '@/src/components/HistoryView';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TeamDrawer } from '@/src/components/TeamDrawer';
import { Text } from '@/src/components/Text';
import { isHeadlessCicyAgent } from '@/src/lib/agentType';
import type { PendingAttachment } from '@/src/lib/attachments';
import { checkApkUpdate, type ApkUpdate } from '@/src/lib/appUpdate';
import { useOtaReady } from '@/src/lib/otaInfo';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

// Wide (pad/desktop) breakpoint — below it, the phone single-chat layout.
const WIDE_BP = 820;

// The hub's primary agent — the coordinator (协调官); phone chats only with it,
// pad defaults its selection to it. Prefer an explicit coordinator role/title,
// then the team master, then the first reachable agent.
function pickPrimary(dir: HubAgent[]): HubAgent | null {
  if (dir.length === 0) return null;
  const isCoordinator = (a: HubAgent) =>
    /coordinator/i.test(a.role || '') || /协调官|coordinator/i.test(a.title || '');
  return dir.find(isCoordinator) ?? dir.find((a) => a.role === 'master') ?? dir[0];
}

export default function HubScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const hub = useAuthStore((s) => s.hub);
  const setHubTeams = useAuthStore((s) => s.setHubTeams);
  const { width } = useWindowDimensions();
  const isWide = width >= WIDE_BP;

  // Update banners — the Hub is the home, so it (not the teams screen) surfaces
  // the OTA-ready "tap to apply" prompt + the Android sideload APK-update banner.
  const ota = useOtaReady();
  const [apkUpdate, setApkUpdate] = useState<ApkUpdate | null>(null);
  useEffect(() => {
    let alive = true;
    checkApkUpdate().then((u) => { if (alive && u) setApkUpdate(u); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const [status, setStatus] = useState<HubWsStatus>('idle');
  const [directory, setDirectory] = useState<HubAgent[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);

  const clientRef = useRef<HubWsClient | null>(null);

  // One WS for the whole screen's lifetime. Connected = the scanned state.
  useEffect(() => {
    if (!hub) return;
    const client = new HubWsClient({ hubUrl: hub.url, hubToken: hub.token });
    clientRef.current = client;
    const offDir = client.onDirectory((d) => {
      setDirectory(d);
      // Mirror the hub's teams into the team list so the drawer + /agents see
      // them (each <team> group → a queryToken team reached at the node base).
      void setHubTeams(d, hub.token);
    });
    const offStatus = client.onStatus((s) => setStatus(s));
    client.connect();
    return () => {
      offDir();
      offStatus();
      client.close();
      clientRef.current = null;
    };
  }, [hub?.url, hub?.token]);

  const primary = useMemo(() => pickPrimary(directory), [directory]);

  // The agent the chat is bound to: phone → always the coordinator; pad → the
  // left-list selection (defaults to the coordinator).
  const active = useMemo<HubAgent | null>(() => {
    if (!isWide) return primary;
    return directory.find((a) => a.addr === selectedAddr) ?? primary;
  }, [isWide, directory, selectedAddr, primary]);

  // Subscribe to the active agent's chat stream; unsubscribe on change.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !active) return;
    client.subscribe(active.addr);
    return () => client.unsubscribe(active.addr);
  }, [active?.addr]);

  if (!hub) {
    // Home is always the Hub — even before a connection. Bounce is avoided; the
    // screen itself shows a scan/token prompt below.
  }

  const subtitle = !hub
    ? t('hub.notConnected')
    : status === 'open'
      ? active
        ? active.title || active.wid.split(':')[0]
        : t('hub.empty')
      : status === 'connecting'
        ? t('hub.connecting')
        : t('hub.offline');

  const banner = ota.ready ? (
    <PressableScale
      onPress={ota.apply}
      haptic
      scaleTo={0.98}
      style={[styles.updateBanner, { backgroundColor: theme.surface, borderColor: theme.accent }]}
    >
      <Ionicons name="flash" size={18} color={theme.accent} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="caption" style={{ color: theme.accent }}>{t('update.otaReady')}</Text>
        <Text variant="caption" tone="faint" numberOfLines={1}>{t('update.otaTapToApply')}</Text>
      </View>
    </PressableScale>
  ) : apkUpdate ? (
    <PressableScale
      onPress={() => { Linking.openURL(apkUpdate.apk).catch(() => {}); }}
      haptic
      scaleTo={0.98}
      style={[styles.updateBanner, { backgroundColor: theme.surface, borderColor: theme.accent }]}
    >
      <Ionicons name="arrow-down-circle" size={18} color={theme.accent} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="caption" style={{ color: theme.accent }}>{t('update.available', { version: apkUpdate.version })}</Text>
        <Text variant="caption" tone="faint" numberOfLines={1}>{t('update.tapToInstall')}</Text>
      </View>
      <PressableScale onPress={() => setApkUpdate(null)} hitSlop={8}>
        <Ionicons name="close" size={16} color={theme.textFaint} />
      </PressableScale>
    </PressableScale>
  ) : null;

  // Header — narrow shows a ☰ (org/teams drawer); wide has the persistent left
  // list instead, so the ☰ is dropped there.
  const header = (
    <View style={[styles.header, { borderBottomColor: theme.border }]}>
      {/* ☰ org/teams drawer — on both phone and pad. */}
      <PressableScale onPress={() => setDrawerOpen(true)} haptic scaleTo={0.94} hitSlop={8} style={styles.iconBtn}>
        <Ionicons name="menu" size={24} color={theme.text} />
      </PressableScale>
      {active ? (
        <AgentAvatar agentType={active.agent_type} title={active.title} size={32} bordered />
      ) : (
        <View style={[styles.hubIcon, { backgroundColor: theme.accent }]}>
          <Ionicons name="git-network-outline" size={18} color={theme.accentText} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text variant="callout" numberOfLines={1}>{t('hub.title')}</Text>
        <Text variant="caption" tone="faint" numberOfLines={1}>{subtitle}</Text>
      </View>
      {hub ? (
        <View style={[styles.statusDot, { backgroundColor: status === 'open' ? theme.accent : theme.textFaint }]} />
      ) : null}
    </View>
  );

  // The scan/connect prompt shown when no hub is connected yet.
  const connectPrompt = (
    <View style={styles.empty}>
      <Ionicons name="qr-code-outline" size={48} color={theme.textFaint} />
      <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>{t('hub.notConnected')}</Text>
      <View style={{ height: spacing.lg }} />
      <Button title={t('hub.scanToConnect')} onPress={() => router.push('/scan')} />
    </View>
  );

  // ── WIDE (pad/desktop): two-pane master-detail ──
  if (isWide) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']}>
        {header}
        {banner}
        <View style={{ flex: 1, flexDirection: 'row', minHeight: 0 }}>
          {/* Left: the hub's reachable agents (coordinator first). */}
          <View style={[styles.leftPane, { borderRightColor: theme.border }]}>
            <ScrollView contentContainerStyle={{ paddingVertical: spacing.xs }}>
              {directory.map((a) => {
                const sel = active?.addr === a.addr;
                return (
                  <PressableScale
                    key={a.addr}
                    onPress={() => setSelectedAddr(a.addr)}
                    scaleTo={0.98}
                    style={[styles.agentRow, sel && { backgroundColor: theme.surfaceMuted }]}
                  >
                    <AgentAvatar agentType={a.agent_type} title={a.title} size={34} bordered />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text variant="callout" numberOfLines={1}>{a.title || a.wid.split(':')[0]}</Text>
                      <Text variant="caption" tone="faint" numberOfLines={1}>
                        {[a.model, a.status].filter(Boolean).join(' · ') || a.wid.split(':')[0]}
                      </Text>
                    </View>
                  </PressableScale>
                );
              })}
              {directory.length === 0 ? (
                <Text tone="muted" style={{ padding: spacing.lg, textAlign: 'center' }}>
                  {status === 'open' ? t('hub.empty') : t('hub.connecting')}
                </Text>
              ) : null}
            </ScrollView>
          </View>
          {/* Right: chat with the selected agent. */}
          <View style={{ flex: 1, minWidth: 0 }}>
            {!hub ? connectPrompt : active ? <HubChat key={active.addr} agent={active} hubToken={hub.token} /> : (
              <View style={styles.empty}>
                <Ionicons name="git-network-outline" size={48} color={theme.textFaint} />
                <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>
                  {status === 'open' ? t('hub.empty') : t('hub.connecting')}
                </Text>
              </View>
            )}
          </View>
        </View>
        <TeamDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      </Screen>
    );
  }

  // ── NARROW (phone): single coordinator chat + ☰ drawer (unchanged). ──
  return (
    <Screen edges={['top', 'left', 'right']}>
      {header}
      {banner}
      <View style={{ flex: 1, minHeight: 0 }}>
        {!hub ? connectPrompt : active ? <HubChat key={active.addr} agent={active} hubToken={hub.token} /> : (
          <View style={styles.empty}>
            <Ionicons name="git-network-outline" size={48} color={theme.textFaint} />
            <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>
              {status === 'open' ? t('hub.empty') : t('hub.connecting')}
            </Text>
          </View>
        )}
      </View>
      <TeamDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </Screen>
  );
}

// The chat pane for one agent — history in the middle + the composer absolutely
// pinned to the bottom (lifts over the keyboard). Owns its own input/send state;
// remounted per agent (key=addr) so switching never leaks state.
function HubChat({ agent, hubToken }: { agent: HubAgent; hubToken: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  // Keyboard height — edge-to-edge means the window doesn't resize, so lift the
  // absolutely-pinned composer by the keyboard height ourselves.
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKbH(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKbH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const [composerH, setComposerH] = useState(96);

  const shortWid = agent.wid.split(':')[0];
  // Reach the node with our hubToken via ?token= (Bearer 401s under the hub's
  // security model; agent.token no longer exists).
  const endpoint = useMemo<Endpoint>(
    () => ({ serverUrl: agent.reach_url, token: hubToken, queryToken: true }),
    [agent.reach_url, hubToken],
  );
  const agentApi = useMemo(() => createApi(endpoint), [endpoint]);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ text: string; nonce: number } | null>(null);

  async function submit(text: string) {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setInput('');
    try {
      setPending({ text: body, nonce: Date.now() });
      await agentApi.sendToAgent(shortWid, body, true);
    } catch {
      setPending(null);
    } finally {
      setSending(false);
    }
  }

  async function sendAttachments(atts: PendingAttachment[]) {
    if (!atts.length || sending) return;
    const caption = input.trim();
    setInput('');
    setSending(true);
    try {
      const refs: string[] = [];
      for (const a of atts) {
        try {
          const r = await uploadAttachment(shortWid, a.uri, a.name, a.mime, endpoint);
          const isVid = a.kind === 'video' || r.contentType.startsWith('video/');
          const abs = r.fileRef ? '/' + r.fileRef.replace(/^file:\/\//, '').replace(/^\/+/, '') : r.url;
          refs.push(r.isImage ? `![${r.name}](${abs})` : `[${isVid ? '🎬 ' : ''}${r.name}](${abs})`);
        } catch {
          /* skip the failed one */
        }
      }
      if (!refs.length) return;
      const body = `${caption ? `${caption}\n\n` : ''}${refs.join('\n\n')}`;
      setPending({ text: body, nonce: Date.now() });
      await agentApi.sendToAgent(shortWid, body, true);
    } catch {
      setPending(null);
    } finally {
      setSending(false);
    }
  }

  async function stopGeneration() {
    try {
      if (isHeadlessCicyAgent(agent.agent_type)) await agentApi.cancelCicyReply(shortWid);
      else await agentApi.sendKeys(shortWid, 'Escape');
    } catch {
      /* best-effort */
    }
  }

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.bg }}>
      <View style={{ flex: 1, minHeight: 0, paddingBottom: composerH + kbH }}>
        <HistoryView
          agentId={shortWid}
          endpoint={endpoint}
          pending={pending}
          onReplyInFlight={() => setBusy(true)}
          onReplyDone={() => setBusy(false)}
          agentType={agent.agent_type}
          busy={busy}
        />
      </View>
      <View
        onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}
        style={[
          styles.composer,
          {
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: kbH > 0 ? kbH + (Platform.OS === 'android' ? spacing.md : 0) : 0,
            backgroundColor: theme.bg,
            borderTopColor: theme.border,
            paddingBottom: kbH > 0 ? spacing.sm : Math.max(insets.bottom, spacing.lg),
          },
        ]}
      >
        <Composer
          value={input}
          onChangeText={setInput}
          onSubmit={() => void submit(input)}
          onTranscript={(txt) => void submit(txt)}
          onPickAttachments={(atts) => void sendAttachments(atts)}
          sending={sending}
          busy={busy}
          onStop={() => void stopGeneration()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20 },
  hubIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  leftPane: { width: 300, borderRightWidth: StyleSheet.hairlineWidth },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
  updateBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  composer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
