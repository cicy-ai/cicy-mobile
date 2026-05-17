import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';

import { ChatWsClient } from '@/src/api/chatws';
import { api } from '@/src/api/http';
import type { HistoryStep, HistoryTurn, WsServerMessage } from '@/src/api/types';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { TypingDots } from './TypingDots';

// Statuses the TypingDots indicator cares about (kept lowercase). A persisted
// snapshot frozen in one of these states would otherwise show dots forever.
const ACTIVE_STATUSES = new Set(['streaming', 'pending', 'tool_use', 'thinking']);

// Strip stale "active" status from a snapshot turn so the typing indicator
// doesn't show on first load. WS events will re-arm it if needed.
function deactivate(t: HistoryTurn): HistoryTurn {
  const s = (t.status ?? '').toLowerCase();
  return ACTIVE_STATUSES.has(s) ? { ...t, status: '' } : t;
}

// Mirror of the desktop dedupe key (CurrentHistoryView.tsx). Every WS event
// for a single delta gets a stable signature, so a reconnect that replays the
// same chunk won't double-append it.
function eventKey(type: string, data: any): string {
  return [
    type,
    String(data?.agent_id ?? ''),
    String(data?.conversation_id ?? ''),
    String(data?.turn_id ?? ''),
    String(data?.history_id ?? ''),
    String(data?.updated_at ?? ''),
    String(data?.delta ?? ''),
  ].join(':');
}

type Props = {
  // The agent's short pane id (e.g. "w-10018") — same key chat-ws uses.
  agentId: string;
};

const PAGE_SIZE = 3;

// Mobile history view — minimal logic:
//   1. On mount, fetch the latest 3 turns
//   2. Pull-to-refresh fetches 3 OLDER turns (prepended) until exhausted
//   3. Everything after that is in-memory state, updated by chat-ws pushes
//
// We never re-fetch the full snapshot mid-session; once a turn is in state it
// only mutates from ai_chunk / status_change / current_updated events.
export function HistoryView({ agentId }: Props) {
  const theme = useTheme();
  const { serverUrl, token, clientId } = useAuthStore();

  // We hold turns in **newest-first** order to play nicely with `inverted`
  // FlatList semantics (data[0] renders at the visual bottom, which is where
  // we want the latest turn).
  const [turns, setTurns] = useState<HistoryTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<HistoryTurn>>(null);

  // Initial: latest PAGE_SIZE turns. API returns oldest→newest, we reverse.
  // We strip any "active" status (streaming/pending/tool_use/thinking) on
  // load — the snapshot may have been saved mid-reply on the last session,
  // and we don't want the typing dots to be on permanently. WS events will
  // re-arm streaming if the reply is genuinely still in flight.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.getHistoryView(agentId, { limit: PAGE_SIZE, offset: 0 });
        if (!alive) return;
        const items = (data.data ?? []).slice().reverse().map(deactivate);
        setTurns(items);
        setExhausted(items.length < PAGE_SIZE);
      } catch (e: any) {
        if (alive) setError(String(e?.message ?? e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  // Pull-to-refresh = "load older". In inverted mode the visual top is where
  // the oldest item lives, so this aligns with the user's mental model. New
  // older items go to the END of our newest-first array.
  const loadOlder = useCallback(async () => {
    if (refreshing || exhausted) return;
    setRefreshing(true);
    try {
      const data = await api.getHistoryView(agentId, { limit: PAGE_SIZE, offset: turns.length });
      const older = (data.data ?? []).slice().reverse().map(deactivate);
      if (older.length === 0) {
        setExhausted(true);
      } else {
        setTurns((prev) => [...prev, ...older]);
        if (older.length < PAGE_SIZE) setExhausted(true);
      }
    } catch {
      // Ignore — user can swipe again.
    } finally {
      setRefreshing(false);
    }
  }, [agentId, refreshing, exhausted, turns.length]);

  // WS pushes — everything stays in memory after the initial fetch.
  const client = useMemo(() => {
    if (!serverUrl || !token || !agentId) return null;
    return new ChatWsClient({ serverUrl, token, clientId, agentId });
  }, [serverUrl, token, clientId, agentId]);

  // Track the last event signature to deduplicate replays on WS reconnect.
  const lastEventKeyRef = useRef<string>('');

  useEffect(() => {
    if (!client) return;
    const off = client.on((msg) => handleWsMessage(msg, agentId, setTurns, lastEventKeyRef));
    client.connect();
    return () => {
      off();
      client.close();
    };
  }, [client, agentId]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.center}>
        <Text variant="callout" tone="danger" style={{ textAlign: 'center' }}>
          {error}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={turns}
      inverted
      keyExtractor={(t, i) => `${t.history_id ?? t.turn_id ?? t.ts ?? 'n'}#${i}`}
      contentContainerStyle={styles.list}
      renderItem={({ item, index }) => (
        // In inverted mode data[0] is the latest turn — that's the one we
        // want streaming indicators on.
        <Turn turn={item} isLast={index === 0} />
      )}
      // onEndReached in inverted mode fires at the VISUAL TOP — which is where
      // the user expects "load earlier" to trigger.
      onEndReached={loadOlder}
      onEndReachedThreshold={0.4}
      ListFooterComponent={
        // In inverted mode the footer renders at the visual TOP. Use it to
        // surface the loading / exhausted state for earlier turns.
        turns.length === 0 ? null : refreshing ? (
          <View style={styles.loadMoreRow}>
            <ActivityIndicator size="small" color={theme.textMuted} />
          </View>
        ) : exhausted ? (
          <View style={styles.loadMoreRow}>
            <Text variant="caption" tone="faint">
              · beginning of history ·
            </Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text tone="muted" variant="h3" style={{ marginBottom: spacing.sm }}>
            No recorded turns
          </Text>
          <Text tone="faint" variant="callout" style={{ textAlign: 'center' }}>
            This agent hasn't generated any history yet, or it's routing
            directly to anthropic.com.
            {'\n\n'}
            Switch to the CLI tab to see the live terminal.
          </Text>
        </View>
      }
    />
  );
}

function Turn({ turn, isLast }: { turn: HistoryTurn; isLast: boolean }) {
  const theme = useTheme();
  const status = (turn.status ?? '').toLowerCase();
  const streaming = isLast && (status === 'streaming' || status === 'pending' || status === 'tool_use');

  return (
    <View style={{ gap: spacing.md }}>
      {turn.q ? (
        <View style={styles.qRow}>
          <View style={[styles.qBubble, { backgroundColor: theme.accent }]}>
            <Text style={{ color: theme.accentText, fontSize: 15, lineHeight: 22 }}>{turn.q}</Text>
          </View>
        </View>
      ) : null}

      <View style={{ gap: spacing.sm, paddingRight: spacing.lg }}>
        {(turn.steps ?? []).map((step, i) => (
          <Step
            key={i}
            step={step}
            streaming={streaming && i === (turn.steps?.length ?? 0) - 1}
          />
        ))}

        {/* If the API only sent a flat `a` and no steps, render it as a text block. */}
        {(!turn.steps || turn.steps.length === 0) && turn.a ? <RichText text={turn.a} /> : null}

        {streaming ? (
          <View>
            <TypingDots />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Step({ step, streaming }: { step: HistoryStep; streaming: boolean }) {
  if (step.type === 'thinking' && typeof step.text === 'string') {
    return <ThinkingBlock text={step.text} streaming={streaming} />;
  }
  if (step.type === 'text' && typeof step.text === 'string') {
    return <RichText text={step.text} />;
  }
  if (step.type === 'tool' && Array.isArray(step.tools)) {
    return <ToolStrip tools={step.tools as { name?: string }[]} />;
  }
  return null;
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(streaming);
  useEffect(() => {
    if (streaming) setExpanded(true);
  }, [streaming]);
  const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;

  return (
    <PressableScale
      onPress={() => setExpanded((v) => !v)}
      haptic
      scaleTo={0.99}
      style={[styles.thinking, { borderLeftColor: theme.borderStrong }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Text variant="caption" tone="faint" style={{ textTransform: 'uppercase' }}>
          Thinking
        </Text>
        <Text variant="caption" tone="faint">
          · {text.length}
        </Text>
        <View style={{ flex: 1 }} />
        <Text variant="caption" tone="faint">
          {expanded ? '▲' : '▼'}
        </Text>
      </View>
      <Text variant="callout" tone="muted">
        {expanded ? text : preview}
      </Text>
    </PressableScale>
  );
}

function ToolStrip({ tools }: { tools: { name?: string }[] }) {
  const theme = useTheme();
  return (
    <View style={styles.toolRow}>
      {tools.map((t, i) => (
        <View key={i} style={[styles.toolChip, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
          <Text variant="caption" tone="muted">
            {`▸ ${t.name ?? 'tool'}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function RichText({ text }: { text: string }) {
  const theme = useTheme();
  const segments = useMemo(() => splitFencedCode(text), [text]);
  return (
    <View style={{ gap: spacing.sm }}>
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <View key={i} style={[styles.codeBlock, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
            {seg.lang ? (
              <Text variant="caption" tone="faint" style={{ marginBottom: 4 }}>
                {seg.lang}
              </Text>
            ) : null}
            <Text style={[typeScale.mono, { color: theme.text }]} selectable>
              {seg.text}
            </Text>
          </View>
        ) : (
          <Text key={i} variant="body" selectable>
            {seg.text}
          </Text>
        ),
      )}
    </View>
  );
}

type Segment = { kind: 'text' | 'code'; text: string; lang?: string };

function splitFencedCode(input: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > lastIndex) {
      const before = input.slice(lastIndex, m.index).replace(/^\s+|\s+$/g, '');
      if (before) out.push({ kind: 'text', text: before });
    }
    out.push({ kind: 'code', lang: m[1].trim() || undefined, text: m[2].replace(/\s+$/, '') });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < input.length) {
    const tail = input.slice(lastIndex).replace(/^\s+|\s+$/g, '');
    if (tail) out.push({ kind: 'text', text: tail });
  }
  if (out.length === 0) out.push({ kind: 'text', text: input });
  return out;
}

// Pure in-memory WS handling — never re-fetches the snapshot. State is held
// newest-first (prev[0] = latest turn) because the FlatList is `inverted`.
//
// Matching by `history_id` (not array position) keeps streaming chunks landing
// on the correct turn even if a `current_updated` for a NEW turn races ahead.
// Mirrors desktop CurrentHistoryView.tsx semantics.
function handleWsMessage(
  msg: WsServerMessage,
  agentId: string,
  setTurns: React.Dispatch<React.SetStateAction<HistoryTurn[]>>,
  lastEventKeyRef: React.MutableRefObject<string>,
) {
  const type = String(msg?.type ?? '').trim();
  if (type !== 'ai_chunk' && type !== 'status_change' && type !== 'current_updated') return;
  const data = (msg?.data ?? {}) as {
    agent_id?: string;
    history_id?: number;
    conversation_id?: string;
    turn_id?: string;
    status?: string;
    delta?: string;
    question?: string;
    answer?: string;
    thinking?: string;
    updated_at?: string;
  };
  // Ignore cross-talk from other agents on the same socket.
  const evtAgent = String(data?.agent_id ?? '').trim();
  if (evtAgent && evtAgent !== agentId) return;
  // Without a real history_id we can't anchor the update to a turn.
  const historyId = Number(data?.history_id ?? 0);
  if (historyId <= 0) return;

  const sig = eventKey(type, data);
  if (sig && sig === lastEventKeyRef.current) return;
  lastEventKeyRef.current = sig;

  if (type === 'current_updated') {
    const question = String(data?.question ?? '').trim();
    const status = String(data?.status ?? 'thinking').trim() || 'thinking';
    setTurns((prev) => {
      const idx = prev.findIndex((t) => Number(t.history_id ?? 0) === historyId);
      if (idx >= 0) {
        // EXISTING turn: only refresh question / status / conv_id. Never
        // overwrite the accumulated answer/steps — those grow from ai_chunk.
        const next = prev.slice();
        next[idx] = {
          ...prev[idx],
          q: question || prev[idx].q,
          conversation_id: data.conversation_id ?? prev[idx].conversation_id,
          turn_id: data.turn_id ?? prev[idx].turn_id,
          status,
        };
        return next;
      }
      // NEW turn shell — prepend (newest-first because the FlatList is inverted).
      const shell: HistoryTurn = {
        q: question,
        a: '',
        steps: [],
        status,
        history_id: historyId,
        conversation_id: data.conversation_id,
        turn_id: data.turn_id,
      };
      return [shell, ...prev];
    });
    return;
  }

  if (type === 'ai_chunk') {
    const delta = String(data?.delta ?? '');
    if (!delta) return;
    setTurns((prev) => {
      const idx = prev.findIndex((t) => Number(t.history_id ?? 0) === historyId);
      if (idx < 0) {
        // No shell yet — create one so the first chunk still renders.
        const shell: HistoryTurn = {
          q: '',
          a: delta,
          steps: [{ type: 'text', text: delta }],
          status: 'streaming',
          history_id: historyId,
          conversation_id: data.conversation_id,
          turn_id: data.turn_id,
        };
        return [shell, ...prev];
      }
      const current = prev[idx];
      const steps = (current.steps ?? []).slice();
      const textIdx = steps.findIndex((s) => s.type === 'text');
      if (textIdx >= 0) {
        const prevText = String((steps[textIdx] as { text?: string }).text ?? '');
        steps[textIdx] = { type: 'text', text: prevText + delta };
      } else {
        steps.push({ type: 'text', text: delta });
      }
      const next = prev.slice();
      next[idx] = {
        ...current,
        a: (current.a ?? '') + delta,
        steps,
        status: 'streaming',
      };
      return next;
    });
    return;
  }

  if (type === 'status_change') {
    const status = String(data?.status ?? '').trim();
    if (!status) return;
    const thinking = String(data?.thinking ?? '');
    setTurns((prev) => {
      const idx = prev.findIndex((t) => Number(t.history_id ?? 0) === historyId);
      if (idx < 0) return prev;
      const current = prev[idx];
      const steps = (current.steps ?? []).slice();
      if (thinking) {
        const thinkIdx = steps.findIndex((s) => s.type === 'thinking');
        if (thinkIdx >= 0) {
          steps[thinkIdx] = { type: 'thinking', text: thinking };
        } else {
          steps.unshift({ type: 'thinking', text: thinking });
        }
      }
      const next = prev.slice();
      next[idx] = { ...current, status, steps };
      return next;
    });
  }
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing['2xl'],
    gap: spacing['2xl'],
    flexGrow: 1,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing['2xl'] },
  qRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  qBubble: {
    maxWidth: '82%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    borderBottomRightRadius: radius.sm,
  },
  thinking: {
    borderLeftWidth: 2,
    paddingLeft: spacing.md,
    paddingVertical: 4,
  },
  toolRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  toolChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeBlock: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  loadMoreRow: { alignItems: 'center', paddingVertical: spacing.md },
});
