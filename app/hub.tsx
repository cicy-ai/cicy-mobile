// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The Hub screen. A Hub is parallel to teams: one scanned WS connection
// (HubWsClient) reaches the hub. To the user it IS a single agent — tapping Hub
// opens ONE big chat: history in the middle, a single prompt PINNED at the
// bottom (always present). No agent picker; the chat is pointed at the hub's
// master (the dispatcher you talk to), which fans work out to its team behind
// the scenes.
//
// The chat reuses the SAME two-part engine the team chat uses (HistoryView +
// useCurrentHistory), pointed at the master's `reach_url` + node `token` from
// the hub directory via the endpoint override — so the hub chat gets the exact
// committed-window + reply-tail behavior, zero duplication. The hub WS is the
// "one channel" that carries the directory (so we learn the master + its
// reach_url/token); history/reply correctness rides the node HTTP the transparent
// proxy exposes, per cicy-hub/docs/mobile-integration.md.

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Keyboard,
  Linking,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { createApi, type Endpoint } from '@/src/api/http';
import { HubWsClient, type HubAgent, type HubWsStatus } from '@/src/api/hubws';
import { uploadAttachment } from '@/src/api/upload';
import type { PendingAttachment } from '@/src/lib/attachments';
import { AgentAvatar } from '@/src/components/AgentAvatar';
import { Button } from '@/src/components/Button';
import { Composer } from '@/src/components/Composer';
import { HistoryView } from '@/src/components/HistoryView';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TeamDrawer } from '@/src/components/TeamDrawer';
import { Text } from '@/src/components/Text';
import { isHeadlessCicyAgent } from '@/src/lib/agentType';
import { checkApkUpdate, type ApkUpdate } from '@/src/lib/appUpdate';
import { useOtaReady } from '@/src/lib/otaInfo';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

// The hub's primary agent — the ONE agent the single chat talks to. A Hub reads
// to the user as one conversation with the fleet's coordinator (协调官): it
// fans work out to the team via cicy-agent behind the scenes. Lock onto it by
// identity so we never hardcode a wid (demo teams change): prefer an explicit
// coordinator role, then a coordinator-titled agent, then the team master, then
// the first reachable agent.
function pickPrimary(dir: HubAgent[]): HubAgent | null {
  if (dir.length === 0) return null;
  const isCoordinator = (a: HubAgent) =>
    /coordinator/i.test(a.role || '') || /协调官|coordinator/i.test(a.title || '');
  return dir.find(isCoordinator) ?? dir.find((a) => a.role === 'master') ?? dir[0];
}

export default function HubScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const hub = useAuthStore((s) => s.hub);

  // Keyboard height — edge-to-edge (Android) + no KeyboardAvoidingView means the
  // window does NOT resize when the keyboard opens; it just overlays. So we lift
  // the absolutely-pinned composer by the keyboard height ourselves (works the
  // same on iOS, which also doesn't resize without a KAV). No double-count since
  // nothing resizes underneath.
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setKbH(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setKbH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Measured composer height → reserve it under the history so the absolutely
  // pinned composer never overlaps the last message.
  const [composerH, setComposerH] = useState(96);

  // Update banners — the Hub is the home now, so it (not the teams screen) must
  // surface the OTA-ready "tap to apply" prompt, else downloaded updates never
  // get applied. Plus the Android sideload APK-update banner.
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

  const clientRef = useRef<HubWsClient | null>(null);

  // One WS for the whole screen's lifetime. Connected = the scanned state.
  useEffect(() => {
    if (!hub) return;
    const client = new HubWsClient({ hubUrl: hub.url, hubToken: hub.token });
    clientRef.current = client;
    const offDir = client.onDirectory((d) => setDirectory(d));
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

  // Subscribe to the primary's chat stream; unsubscribe on change.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !primary) return;
    client.subscribe(primary.addr);
    return () => client.unsubscribe(primary.addr);
  }, [primary?.addr]);

  // ── The single chat, bound to the primary agent (may be null while the hub
  // directory is still loading — the composer stays visible but disabled). ──
  const shortWid = primary ? primary.wid.split(':')[0] : '';
  // Per w-10122's security change: the hub no longer hands out per-agent node
  // tokens. Reaching a node (history/send + the http upload) authenticates with
  // OUR hubToken (the one used for /_client); the hub validates it and the node
  // dialer swaps in the local token internally. api_token is now 401 on the
  // public net, so never use agent.token.
  const endpoint = useMemo<Endpoint | null>(
    () => (primary && hub ? { serverUrl: primary.reach_url, token: hub.token, queryToken: true } : null),
    [primary?.reach_url, hub?.token],
  );
  const agentApi = useMemo(() => (endpoint ? createApi(endpoint) : null), [endpoint]);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ text: string; nonce: number } | null>(null);

  // Switching primary agent → clear the previous chat's transient state.
  useEffect(() => {
    setPending(null);
    setBusy(false);
  }, [primary?.addr]);

  async function submit(text: string) {
    const body = text.trim();
    if (!body || sending || !agentApi || !primary) return;
    setSending(true);
    setInput('');
    try {
      setPending({ text: body, nonce: Date.now() }); // optimistic q
      await agentApi.sendToAgent(shortWid, body, true);
    } catch {
      setPending(null); // failed → drop the optimistic q
    } finally {
      setSending(false);
    }
  }

  // Attachments — same as the team chat: pick/capture → upload to the agent's
  // node (via the hub endpoint) → send the message with file refs + any caption.
  async function sendAttachments(atts: PendingAttachment[]) {
    if (!atts.length || sending || !agentApi || !primary || !endpoint) return;
    const caption = input.trim();
    setInput('');
    setSending(true);
    try {
      const refs: string[] = [];
      for (const a of atts) {
        try {
          const r = await uploadAttachment(shortWid, a.uri, a.name, a.mime, endpoint);
          const isVid = a.kind === 'video' || r.contentType.startsWith('video/');
          const abs = r.fileRef
            ? '/' + r.fileRef.replace(/^file:\/\//, '').replace(/^\/+/, '')
            : r.url;
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
    if (!agentApi || !primary) return;
    try {
      if (isHeadlessCicyAgent(primary.agent_type)) await agentApi.cancelCicyReply(shortWid);
      else await agentApi.sendKeys(shortWid, 'Escape');
    } catch {
      /* best-effort */
    }
  }

  // Header subtitle: not-connected prompts to scan; connected reflects the
  // coordinator / connection status.
  const subtitle = !hub
    ? t('hub.notConnected')
    : status === 'open'
      ? primary
        ? primary.title || shortWid
        : t('hub.empty')
      : status === 'connecting'
        ? t('hub.connecting')
        : t('hub.offline');

  return (
    <Screen edges={['top', 'left', 'right']}>
      {/* Header — left ☰ opens the org/teams drawer (Hub is the home; teams are
          the secondary stack reached from there) + Hub identity + status dot. */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <PressableScale
          onPress={() => setDrawerOpen(true)}
          haptic
          scaleTo={0.94}
          hitSlop={8}
          style={styles.iconBtn}
        >
          <Ionicons name="menu" size={24} color={theme.text} />
        </PressableScale>
        {primary ? (
          <AgentAvatar agentType={primary.agent_type} title={primary.title} size={32} bordered />
        ) : (
          <View style={[styles.hubIcon, { backgroundColor: theme.accent }]}>
            <Ionicons name="git-network-outline" size={18} color={theme.accentText} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text variant="callout" numberOfLines={1}>
            {t('hub.title')}
          </Text>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {hub ? (
          <View
            style={[styles.statusDot, { backgroundColor: status === 'open' ? theme.accent : theme.textFaint }]}
          />
        ) : null}
      </View>

      {/* OTA-ready / APK-update banner. The Hub is the home now, so it must
          carry this — otherwise a downloaded OTA never gets a "tap to apply". */}
      {ota.ready ? (
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
            <Text variant="caption" style={{ color: theme.accent }}>
              {t('update.available', { version: apkUpdate.version })}
            </Text>
            <Text variant="caption" tone="faint" numberOfLines={1}>{t('update.tapToInstall')}</Text>
          </View>
          <PressableScale onPress={() => setApkUpdate(null)} hitSlop={8}>
            <Ionicons name="close" size={16} color={theme.textFaint} />
          </PressableScale>
        </PressableScale>
      ) : null}

      {/* Chat area. The composer is ABSOLUTELY pinned to the bottom of this box
          (per request) so no flex/KAV quirk can push it off-screen on native;
          the history reserves `composerH` of bottom padding so the last message
          never hides behind it. */}
      <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.bg }}>
        <View style={{ flex: 1, minHeight: 0, paddingBottom: composerH + kbH }}>
          {!hub ? (
            <View style={styles.empty}>
              <Ionicons name="qr-code-outline" size={48} color={theme.textFaint} />
              <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>
                {t('hub.notConnected')}
              </Text>
              <View style={{ height: spacing.lg }} />
              <Button title={t('hub.scanToConnect')} onPress={() => router.push('/scan')} />
            </View>
          ) : primary && endpoint ? (
            <HistoryView
              key={primary.addr}
              agentId={shortWid}
              endpoint={endpoint}
              pending={pending}
              onReplyInFlight={() => setBusy(true)}
              onReplyDone={() => setBusy(false)}
              agentType={primary.agent_type}
              busy={busy}
            />
          ) : (
            <View style={styles.empty}>
              <Ionicons name="git-network-outline" size={48} color={theme.textFaint} />
              <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>
                {status === 'open' ? t('hub.empty') : t('hub.connecting')}
              </Text>
            </View>
          )}
        </View>

        {/* Prompt — absolutely pinned to the bottom, voice-first on native. */}
        <View
          onLayout={(e) => setComposerH(e.nativeEvent.layout.height)}
          style={[
            styles.composer,
            {
              position: 'absolute',
              left: 0,
              right: 0,
              // Lift by the keyboard height so the composer sits above it. On
              // Android edge-to-edge the reported height sits the pill flush on
              // the keyboard, so add a small gap; nothing to add at rest.
              bottom: kbH > 0 ? kbH + (Platform.OS === 'android' ? spacing.md : 0) : 0,
              backgroundColor: theme.bg,
              borderTopColor: theme.border,
              // At rest: sit flush against the bottom safe area — no extra gap.
              // iOS: just the home-indicator inset. Android edge-to-edge reports
              // ~0, so floor it to spacing.lg to clear the gesture bar. Keyboard
              // open: a tight pad since the composer is lifted onto the keyboard.
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

      {/* The org / teams drawer — teams are the secondary stack, opened here. */}
      <TeamDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </Screen>
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
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  hubIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  composer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
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
});
