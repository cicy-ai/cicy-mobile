// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The Hub big-chat screen. A Hub is parallel to teams: one scanned WS
// connection (HubWsClient) reaches every agent across teams. Tapping Hub lands
// you DIRECTLY on the big chat (history in the middle, prompt at the bottom) —
// not a directory picker. Which reachable agent the chat talks to is a chip row
// at the top; it auto-picks the first agent when the directory arrives.
//
// The chat reuses the SAME two-part engine the team chat uses (HistoryView +
// useCurrentHistory), pointed at the selected agent's `reach_url` + node `token`
// via the endpoint override — so a hub agent gets the exact committed-window +
// reply-tail behavior, zero duplication. The hub WS is the "one channel" for the
// directory (and later chat acceleration); history/reply correctness rides the
// node HTTP the directory hands us, per cicy-hub/docs/mobile-integration.md.

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
  const [selectedAddr, setSelectedAddr] = useState<string | null>(null);

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

  // Auto-pick the first reachable agent once the directory lands; keep the
  // current pick if it's still reachable, otherwise fall back to the first.
  useEffect(() => {
    if (directory.length === 0) {
      setSelectedAddr(null);
      return;
    }
    setSelectedAddr((prev) =>
      prev && directory.some((a) => a.addr === prev) ? prev : directory[0].addr,
    );
  }, [directory]);

  const selected = useMemo(
    () => directory.find((a) => a.addr === selectedAddr) ?? null,
    [directory, selectedAddr],
  );

  // Subscribe to the selected agent's chat stream; unsubscribe on switch away.
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !selected) return;
    client.subscribe(selected.addr);
    return () => client.unsubscribe(selected.addr);
  }, [selected?.addr]);

  if (!hub) return null;

  const statusLabel =
    status === 'open'
      ? t('hub.subtitle', { count: directory.length })
      : status === 'connecting'
        ? t('hub.connecting')
        : t('hub.offline');

  return (
    <Screen edges={['top', 'left', 'right']}>
      {/* Header — back + Hub title + live status dot. */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <View style={{ flex: 1 }}>
          <Text variant="h3">{t('hub.title')}</Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {selected ? `${selected.title || selected.wid} · ${selected.team}` : statusLabel}
          </Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: status === 'open' ? theme.accent : theme.textFaint }]} />
      </View>

      {/* Agent selector — the reachable agents as chips. Which one the big chat
          below is pointed at. Hidden when there's nothing to choose. */}
      {directory.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
          style={[styles.chipsBar, { borderBottomColor: theme.border }]}
        >
          {directory.map((a) => {
            const active = a.addr === selectedAddr;
            return (
              <PressableScale
                key={a.addr}
                onPress={() => setSelectedAddr(a.addr)}
                haptic
                scaleTo={0.96}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? theme.accent : theme.surface,
                    borderColor: active ? theme.accent : theme.border,
                  },
                ]}
              >
                <AgentAvatar agentType={a.agent_type} title={a.title} size={20} bordered={false} />
                <Text
                  variant="caption"
                  numberOfLines={1}
                  style={{ color: active ? theme.accentText : theme.text, maxWidth: 120 }}
                >
                  {a.title || a.wid.split(':')[0]}
                </Text>
              </PressableScale>
            );
          })}
        </ScrollView>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          {selected ? (
            <HubChatBody key={selected.addr} agent={selected} />
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

// The chat body + composer for one selected hub agent. Endpoint = its node
// reach_url + token, so the shared HistoryView engine polls the node exactly
// like a team agent. Remounted per agent (key=addr) so state never leaks across.
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
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  chipsBar: {
    flexGrow: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingLeft: spacing.xs,
    paddingRight: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill ?? 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
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
