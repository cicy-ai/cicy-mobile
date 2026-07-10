// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The Hub screen. A Hub is parallel to teams: one scanned WS connection
// (HubWsClient) reaches the hub. To the user it IS a single agent — tapping Hub
// opens ONE big chat: history in the middle, a single prompt at the bottom. No
// agent picker; the chat is pointed at the hub's master (the dispatcher you
// talk to), which fans work out to its team behind the scenes.
//
// The chat reuses the SAME two-part engine the team chat uses (HistoryView +
// useCurrentHistory), pointed at the master's `reach_url` + node `token` from
// the hub directory via the endpoint override — so the hub chat gets the exact
// committed-window + reply-tail behavior, zero duplication. The hub WS is the
// "one channel" that carries the directory (so we learn the master + its
// reach_url/token); history/reply correctness rides the node HTTP that transparent
// proxy exposes, per cicy-hub/docs/mobile-integration.md.

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';

import { createApi, type Endpoint } from '@/src/api/http';
import { HubWsClient, type HubAgent, type HubWsStatus } from '@/src/api/hubws';
import { AgentAvatar } from '@/src/components/AgentAvatar';
import { Composer } from '@/src/components/Composer';
import { HistoryView } from '@/src/components/HistoryView';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { isHeadlessCicyAgent } from '@/src/lib/agentType';
import { useAuthStore } from '@/src/store/auth';
import { spacing, useTheme } from '@/src/theme';

// The hub's primary agent — the one the single chat talks to. Prefer the team
// master (dispatcher); fall back to the first reachable agent.
function pickPrimary(dir: HubAgent[]): HubAgent | null {
  if (dir.length === 0) return null;
  return dir.find((a) => a.role === 'master') ?? dir[0];
}

export default function HubScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const hub = useAuthStore((s) => s.hub);

  const [status, setStatus] = useState<HubWsStatus>('idle');
  const [directory, setDirectory] = useState<HubAgent[]>([]);

  const clientRef = useRef<HubWsClient | null>(null);

  // No hub connected (e.g. deep-linked here after a disconnect) → bounce to scan.
  useEffect(() => {
    if (!hub) router.replace('/scan');
  }, [hub]);

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

  if (!hub) return null;

  return (
    <Screen edges={['top', 'left', 'right']}>
      {/* Header — back + Hub title + live status dot. */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
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
            {status === 'open'
              ? primary
                ? primary.title || primary.wid.split(':')[0]
                : t('hub.empty')
              : status === 'connecting'
                ? t('hub.connecting')
                : t('hub.offline')}
          </Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: status === 'open' ? theme.accent : theme.textFaint }]} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          {primary ? (
            <HubChatBody key={primary.addr} agent={primary} />
          ) : (
            <View style={styles.empty}>
              <Ionicons name="git-network-outline" size={48} color={theme.textFaint} />
              <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>
                {status === 'open' ? t('hub.empty') : t('hub.connecting')}
              </Text>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// The chat body + single bottom prompt for the hub's primary agent. Endpoint =
// its node reach_url + token, so the shared HistoryView engine polls the node
// exactly like a team agent.
function HubChatBody({ agent }: { agent: HubAgent }) {
  const theme = useTheme();

  const shortWid = agent.wid.split(':')[0];
  const endpoint: Endpoint = useMemo(
    () => ({ serverUrl: agent.reach_url, token: agent.token }),
    [agent.reach_url, agent.token],
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
      setPending({ text: body, nonce: Date.now() }); // optimistic q
      await agentApi.sendToAgent(shortWid, body, true);
    } catch {
      setPending(null); // failed → drop the optimistic q
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
    <>
      <View style={{ flex: 1 }}>
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

      <View style={[styles.composer, { backgroundColor: theme.bg, borderTopColor: theme.border }]}>
        <Composer
          value={input}
          onChangeText={setInput}
          onSubmit={() => void submit(input)}
          onTranscript={(txt) => void submit(txt)}
          disabled={false}
          sending={sending}
          busy={busy}
          onStop={() => void stopGeneration()}
        />
      </View>
    </>
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
});
