// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The Hub big-chat screen. A Hub is parallel to teams: one scanned WS
// connection (HubWsClient) fans out to every reachable agent across teams.
// Landing = the directory (reachable agents); tap one → the big chat.
//
// The chat reuses the SAME two-part engine the team chat uses (HistoryView +
// useCurrentHistory), pointed at that agent's `reach_url` + node `token` via the
// endpoint override — so a hub agent gets the exact committed-window + reply-tail
// behavior, zero duplication. The hub WS is the "one channel" for the directory
// and (later) chat acceleration; history/reply correctness rides the node HTTP
// the directory hands us (reach_url + token), per cicy-hub/docs/mobile-integration.md.

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
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
import { radius, spacing, useTheme } from '@/src/theme';

export default function HubScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const hub = useAuthStore((s) => s.hub);

  const [status, setStatus] = useState<HubWsStatus>('idle');
  const [directory, setDirectory] = useState<HubAgent[]>([]);
  const [selected, setSelected] = useState<HubAgent | null>(null);

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

  // Subscribe to the selected agent's chat stream; unsubscribe on switch away.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !selected) return;
    client.subscribe(selected.addr);
    return () => client.unsubscribe(selected.addr);
  }, [selected?.addr]);

  if (!hub) return null;

  // Directory grouped by team, teams alphabetized, agents keep server order.
  const groups = useMemo(() => {
    const byTeam = new Map<string, HubAgent[]>();
    for (const a of directory) {
      const arr = byTeam.get(a.team) ?? [];
      arr.push(a);
      byTeam.set(a.team, arr);
    }
    return Array.from(byTeam.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([team, agents]) => ({ team, agents }));
  }, [directory]);

  if (selected) {
    return (
      <HubChat
        agent={selected}
        status={status}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <Screen edges={['top', 'left', 'right']}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <View style={{ flex: 1 }}>
          <Text variant="h3">{t('hub.title')}</Text>
          <Text variant="caption" tone="muted">
            {status === 'open'
              ? t('hub.subtitle', { count: directory.length })
              : status === 'connecting'
                ? t('hub.connecting')
                : t('hub.offline')}
          </Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: status === 'open' ? theme.accent : theme.textFaint }]} />
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {groups.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="git-network-outline" size={48} color={theme.textFaint} />
            <Text tone="muted" style={{ marginTop: spacing.md, textAlign: 'center' }}>
              {status === 'open' ? t('hub.empty') : t('hub.connecting')}
            </Text>
          </View>
        ) : (
          groups.map((g) => (
            <View key={g.team} style={{ marginBottom: spacing.lg }}>
              <Text variant="caption" tone="faint" style={styles.teamHeader}>
                {g.team}
              </Text>
              {g.agents.map((a) => (
                <PressableScale
                  key={a.addr}
                  onPress={() => setSelected(a)}
                  haptic
                  scaleTo={0.97}
                  style={styles.agentRow}
                >
                  <AgentAvatar agentType={a.agent_type} title={a.title} size={40} bordered />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="callout" numberOfLines={1}>
                      {a.title || a.wid}
                    </Text>
                    <Text variant="caption" tone="faint" numberOfLines={1}>
                      {[a.model, a.status].filter(Boolean).join(' · ') || a.wid}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={theme.textFaint} />
                </PressableScale>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

// The big chat for one hub agent. Endpoint = its node reach_url + token, so the
// shared HistoryView engine polls the node exactly like a team agent.
function HubChat({ agent, status, onBack }: { agent: HubAgent; status: HubWsStatus; onBack: () => void }) {
  const { t } = useTranslation();
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
    <Screen edges={['top', 'left', 'right']}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={onBack} haptic scaleTo={0.94} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <AgentAvatar agentType={agent.agent_type} title={agent.title} size={32} bordered />
        <View style={{ flex: 1 }}>
          <Text variant="callout" numberOfLines={1}>
            {agent.title || shortWid}
          </Text>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {`${agent.team} · ${status === 'open' ? t('hub.connected') : t('hub.offline')}`}
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
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
      </KeyboardAvoidingView>
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
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  list: { padding: spacing.lg },
  teamHeader: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    marginLeft: spacing.xs,
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.xl * 2,
  },
  composer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
