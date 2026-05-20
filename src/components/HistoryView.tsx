import { useFocusEffect } from 'expo-router';
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

// Mobile history view — two-block model:
//
//   ┌─ historyTurns ────────────────────────┐  q's with history_id, fetched
//   │   committed past turns (visual top)   │  from /api/agents/history-view/
//   │   • have history_id from the db        │  (i.e., backed by history.db)
//   │   • pull-to-refresh loads older        │
//   └────────────────────────────────────────┘
//   ┌─ liveTurns ───────────────────────────┐  q's pushed from WS in-memory
//   │   active/in-flight (visual bottom)     │  (current.json + reply.json),
//   │   • may have no history_id             │  identified by q text, never
//   │   • appended/updated by WS only        │  matched against historyTurns
//   └────────────────────────────────────────┘
//
// On exit/reopen, the live block clears and we re-fetch 3 history items +
// the in-flight snapshot. The two blocks are NEVER reconciled against each
// other — that's exactly why we used to see duplicate q's (the snapshot's
// merged in-flight turn collided with WS-created shells).
export function HistoryView({ agentId }: Props) {
  const theme = useTheme();
  const { serverUrl, token, clientId } = useAuthStore();

  // Both arrays stored newest-first so the inverted FlatList renders the
  // latest live turn at the visual bottom and older history at the visual top.
  const [historyTurns, setHistoryTurns] = useState<HistoryTurn[]>([]);
  const [liveTurns, setLiveTurns] = useState<HistoryTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<HistoryTurn>>(null);

  // Re-fetch on every screen focus, not just on agentId change. The live
  // block clears each time — anything still in flight will re-arrive through
  // either the snapshot split or fresh WS events.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setLoading(true);
      (async () => {
        try {
          const data = await api.getHistoryView(agentId, { limit: PAGE_SIZE, offset: 0 });
          if (!alive) return;
          // API returns oldest→newest; we want newest-first.
          const items = (data.data ?? []).slice().reverse();
          // Split: any turn still in an active status is "live" (in-flight,
          // straight from current.json + reply.json on the backend); the rest
          // are committed history. A frozen-mid-reply snapshot turn keeps its
          // active status here so we can route subsequent WS events to it.
          const liveItems: HistoryTurn[] = [];
          const committedItems: HistoryTurn[] = [];
          for (const t of items) {
            if (ACTIVE_STATUSES.has((t.status ?? '').toLowerCase())) {
              liveItems.push(t);
            } else {
              committedItems.push(deactivate(t));
            }
          }
          setHistoryTurns(committedItems);
          setLiveTurns(liveItems);
          setExhausted(items.length < PAGE_SIZE);
          setError(null);
          lastEventKeyRef.current = '';
        } catch (e: any) {
          if (alive) setError(String(e?.message ?? e));
        } finally {
          if (alive) setLoading(false);
        }
      })();
      return () => {
        alive = false;
      };
    }, [agentId]),
  );

  // Pull-to-refresh = "load older committed history". Only touches the
  // historyTurns array; liveTurns is independent.
  const loadOlder = useCallback(async () => {
    if (refreshing || exhausted) return;
    setRefreshing(true);
    try {
      const data = await api.getHistoryView(agentId, {
        limit: PAGE_SIZE,
        offset: historyTurns.length + liveTurns.length,
      });
      const older = (data.data ?? []).slice().reverse().map(deactivate);
      if (older.length === 0) {
        setExhausted(true);
      } else {
        setHistoryTurns((prev) => [...prev, ...older]);
        if (older.length < PAGE_SIZE) setExhausted(true);
      }
    } catch {
      // Ignore — user can swipe again.
    } finally {
      setRefreshing(false);
    }
  }, [agentId, refreshing, exhausted, historyTurns.length, liveTurns.length]);

  // WS pushes — only ever mutate liveTurns; historyTurns is a read-only window
  // from the server until the next re-fetch.
  const client = useMemo(() => {
    if (!serverUrl || !token || !agentId) return null;
    return new ChatWsClient({ serverUrl, token, clientId, agentId });
  }, [serverUrl, token, clientId, agentId]);

  const lastEventKeyRef = useRef<string>('');

  useEffect(() => {
    if (!client) return;
    const off = client.on((msg) => handleWsMessage(msg, agentId, setLiveTurns, lastEventKeyRef));
    client.connect();
    return () => {
      off();
      client.close();
    };
  }, [client, agentId]);

  // Combined render data: live above (= data[0..], renders at visual bottom),
  // then history. Inverted FlatList means data[0] = visual bottom.
  const data = useMemo(() => [...liveTurns, ...historyTurns], [liveTurns, historyTurns]);

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
      data={data}
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
        data.length === 0 ? null : refreshing ? (
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

// WS handler — only ever mutates the LIVE block. Live turns are identified
// by q text (stable per logical turn), not history_id (which changes between
// audit sessions inside one logical turn — tool_use → tool_result → next
// call each gets its own MaxHistoryID). Events with no q text (ai_chunk,
// status_change) target the latest live turn (live[0]).
//
// "有什么推什么" — whatever the WS pushes, we display it. We never collide
// with the committed history block: history is read-only from the server
// until the next re-fetch.
function handleWsMessage(
  msg: WsServerMessage,
  agentId: string,
  setLive: React.Dispatch<React.SetStateAction<HistoryTurn[]>>,
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
  const evtAgent = String(data?.agent_id ?? '').trim();
  if (evtAgent && evtAgent !== agentId) return;

  const sig = eventKey(type, data);
  if (sig && sig === lastEventKeyRef.current) return;
  lastEventKeyRef.current = sig;

  const historyId = Number(data?.history_id ?? 0);

  if (type === 'current_updated') {
    const question = String(data?.question ?? '').trim();
    const status = String(data?.status ?? 'thinking').trim() || 'thinking';
    setLive((prev) => {
      // Match by q text within the live block — that's the only stable key
      // across audit-session boundaries inside one logical turn.
      if (question) {
        const idx = prev.findIndex((t) => String(t.q ?? '').trim() === question);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = {
            ...prev[idx],
            q: question,
            history_id: historyId || prev[idx].history_id,
            conversation_id: data.conversation_id ?? prev[idx].conversation_id,
            turn_id: data.turn_id ?? prev[idx].turn_id,
            status,
          };
          return next;
        }
      }
      // New live turn — prepend (newest-first).
      const shell: HistoryTurn = {
        q: question,
        a: '',
        steps: [],
        status,
        history_id: historyId || undefined,
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
    setLive((prev) => {
      if (prev.length === 0) {
        // No live turn yet — create one with empty q. current_updated will
        // fill the q in when it arrives.
        return [{
          q: '',
          a: delta,
          steps: [{ type: 'text', text: delta }],
          status: 'streaming',
          history_id: historyId || undefined,
          conversation_id: data.conversation_id,
          turn_id: data.turn_id,
        }];
      }
      // Append to the latest live turn — that's always the in-flight one.
      const current = prev[0];
      const steps = (current.steps ?? []).slice();
      const textIdx = steps.findIndex((s) => s.type === 'text');
      if (textIdx >= 0) {
        const prevText = String((steps[textIdx] as { text?: string }).text ?? '');
        steps[textIdx] = { type: 'text', text: prevText + delta };
      } else {
        steps.push({ type: 'text', text: delta });
      }
      const next = prev.slice();
      next[0] = {
        ...current,
        a: (current.a ?? '') + delta,
        steps,
        status: 'streaming',
        history_id: historyId || current.history_id,
      };
      return next;
    });
    return;
  }

  if (type === 'status_change') {
    const status = String(data?.status ?? '').trim();
    if (!status) return;
    const thinking = String(data?.thinking ?? '');
    setLive((prev) => {
      if (prev.length === 0) return prev;
      const current = prev[0];
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
      next[0] = { ...current, status, steps };
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
