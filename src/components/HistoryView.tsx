import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, type AppStateStatus, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { api } from '@/src/api/http';
import type { HistoryStep, HistoryTurn } from '@/src/api/types';
import { openChatStream, type StreamEvent } from '@/src/lib/chatStream';
import { buildTurnsFromRawItems, normalizeHistoryTurns, splitLeadingHarnessBlocks } from '@/src/lib/historyParse';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { TypingDots } from './TypingDots';

type Props = {
  // The agent's short pane id (e.g. "w-10018").
  agentId: string;
  // A message the composer just sent: render it instantly at the bottom (no
  // waiting for the poll) and kick the reply poll. `nonce` changes per send so
  // the same text can be sent twice; `null` after a failed send clears it.
  pending?: { text: string; nonce: number } | null;
};

// Two-part history (ported from desktop CurrentHistoryView):
//
//   ┌─ committed ───────────────────────────┐  current.json window, parsed
//   │   past turns (visual top)             │  client-side from raw items.
//   │   • each has a real history_id         │  Pull-to-refresh loads older.
//   └────────────────────────────────────────┘
//   ┌─ liveTurn (≤ 1) ──────────────────────┐  reply.json polled answer for
//   │   in-flight answer (visual bottom)     │  q_last (history_id==maxId+1).
//   │   • no q (q_last is committed's tail)  │  Cleared once it migrates into
//   │   • only thinking + text steps         │  committed (maxId advances).
//   └────────────────────────────────────────┘
//
// Reply tail is HTTP-polled (no WebSocket) — active while streaming, idle once
// complete. The tail only renders when reply.history_id == committedMaxId + 1
// AND reply_conversation_id matches the committed conversation (cross-session
// guard). See docs/history-view-two-part-architecture.md.
const WINDOW = 16; // committed items fetched per page ("a screenful + a bit")
const POLL_ACTIVE_MS = 700; // while a reply is streaming
const POLL_IDLE_MS = 2500; // complete / no active turn — watch for the next q

// ── Top-anchor scroll helpers (ported from cicy-code CurrentHistoryView) ────────
// cicy-mobile is React-Native-Web, so a ScrollView's getScrollableNode() IS the
// scrollable <div>; these manipulate scrollTop/scrollHeight directly, exactly like
// the web. On native (no DOM) they no-op gracefully.
function cssEsc(s: string): string {
  const g: any = typeof globalThis !== 'undefined' ? globalThis : {};
  return g.CSS && typeof g.CSS.escape === 'function' ? g.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
function findTurnEl(node: any, turnKey: string): any {
  return node && typeof node.querySelector === 'function' ? node.querySelector(`[data-turn-key="${cssEsc(turnKey)}"]`) : null;
}
// Pin a turn's top to ~8px below the container top (= q anchored to viewport top).
function pinTurnTop(node: any, turnKey: string): boolean {
  const target = findTurnEl(node, turnKey);
  if (!target || typeof target.getBoundingClientRect !== 'function' || typeof node.getBoundingClientRect !== 'function') return false;
  const top = node.scrollTop + (target.getBoundingClientRect().top - node.getBoundingClientRect().top) - 8;
  node.scrollTop = Math.max(0, top);
  return true;
}
// q's top in content coordinates (for the spacer's belowQ measure).
function turnTopInContent(node: any, turnKey: string): number | null {
  const target = findTurnEl(node, turnKey);
  if (!target || typeof target.getBoundingClientRect !== 'function') return null;
  return node.scrollTop + (target.getBoundingClientRect().top - node.getBoundingClientRect().top);
}
// Re-apply across progressive reflow (markdown/fonts/code blocks shift offsetTop).
function scheduleTurnTop(node: any, turnKey: string): { raf: number; timers: number[] } {
  const apply = () => { pinTurnTop(node, turnKey); };
  apply();
  const raf = requestAnimationFrame(apply) as unknown as number;
  const timers = [80, 240, 600].map((d) => setTimeout(apply, d) as unknown as number);
  return { raf, timers };
}
function scheduleBottom(node: any): { raf: number; timers: number[] } {
  const apply = () => { node.scrollTop = node.scrollHeight; };
  apply();
  const raf = requestAnimationFrame(apply) as unknown as number;
  const timers = [80, 240, 600, 1200].map((d) => setTimeout(apply, d) as unknown as number);
  return { raf, timers };
}
function isActiveAssistantStatus(s: string): boolean {
  const v = (s || '').toLowerCase();
  return v === 'streaming' || v === 'pending' || v === 'tool_use' || v === 'running' || v === 'in_progress';
}

export function HistoryView({ agentId, pending }: Props) {
  const theme = useTheme();

  const [committed, setCommitted] = useState<HistoryTurn[]>([]); // oldest→newest
  const [liveTurn, setLiveTurn] = useState<HistoryTurn | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(null); // just-sent q
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollToBottomSoonRef = useRef<() => void>(() => {});
  // Top-anchoring (ported from cicy-code CurrentHistoryView): a new q is pinned to
  // the TOP of the viewport with its reply streaming below it. A bottom spacer is
  // sized ONCE when the q appears (so a short q+reply can still sit at top) and is
  // NOT touched while streaming — the q stays put because the reply grows below it
  // (resizing it per frame jittered). It shrinks once, after the reply settles.
  const [anchorSpacerHeight, setAnchorSpacerHeight] = useState(0);
  const anchorSpacerHeightRef = useRef(0);
  // Unique key for the current optimistic q (bumped per send by nonce), so a 2nd
  // consecutive send produces a DIFFERENT lastUserKey and re-triggers the anchor —
  // otherwise both share 'opt' and the 2nd q never re-pins to the top.
  const optimisticKeyRef = useRef('opt');
  const anchoredQKeyRef = useRef(''); // q key already pinned to top (re-pins only on a NEW q)
  const activeSpacerTurnKeyRef = useRef(''); // q whose reply is in flight → keep spacer alive
  const preserveScrollOffsetRef = useRef(false); // loadOlder prepend → keep position, don't anchor
  const didInitialScrollRef = useRef(false);
  const shouldStickBottomRef = useRef(true);
  const scheduledScrollRef = useRef<{ raf: number; timers: number[] } | null>(null);

  // Mutable state the poll loop reads without re-subscribing.
  const convRef = useRef<string>(''); // committed conversation id
  const maxIdRef = useRef<number>(0); // committed max history_id (id of q_last)
  const committedMinRef = useRef<number>(0); // smallest committed id (paging)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGenRef = useRef(0); // bumped to invalidate a stale poll loop's reschedule
  const aliveRef = useRef(false);
  const reconcilingRef = useRef(false);
  const lastNonceRef = useRef(0); // last processed `pending.nonce`
  // Live WS stream buffer for the in-flight turn (answer/thinking accumulate
  // from deltas). Present only while a reply streams; null otherwise.
  const wsBufRef = useRef<{
    turnId: string;
    historyId: number;
    conversationId: string;
    answer: string;
    thinking: string;
    status: string;
  } | null>(null);
  const wsConnectedRef = useRef(false);
  // Typewriter smoothing: wsBufRef holds the full target; shownRef tracks how
  // many chars are currently revealed so chunky snapshot jumps animate in.
  const shownRef = useRef<{ turnId: string; aLen: number; tLen: number; aFrac: number; tFrac: number }>({
    turnId: '',
    aLen: 0,
    tLen: 0,
    aFrac: 0,
    tFrac: 0,
  });
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  // When a turn finishes we still want to TYPE the remaining backlog out smoothly
  // before migrating it into the committed window. This flag tells smoothTick to
  // run the finalize (loadWindow + drop tail) the moment the reveal catches up.
  const pendingFinalizeRef = useRef(false);
  // Bridge so the poll fallback can drive the same typewriter (defined below).
  const smoothFnsRef = useRef<{ kick: () => void; snap: () => void }>({ kick: () => {}, snap: () => {} });

  // Build the live-tail turn from a reply snapshot: no q (q_last is committed's
  // tail), just thinking + answer. id = committedMaxId + 1.
  const liveTurnFromReply = useCallback(
    (r: {
      history_id: number;
      answer?: string;
      thinking?: string;
      status?: string;
      complete: boolean;
      conversation_id?: string;
      reply_conversation_id?: string;
      model?: string;
    }): HistoryTurn | null => {
      const steps: HistoryStep[] = [];
      const thinking = String(r.thinking ?? '').trim();
      const answer = String(r.answer ?? '').trim();
      if (thinking) steps.push({ type: 'thinking', text: thinking });
      if (answer) steps.push({ type: 'text', text: answer });
      if (!steps.length) return null;
      return {
        history_id: r.history_id,
        conversation_id: r.conversation_id ?? convRef.current,
        role: 'assistant',
        q: '',
        text: '',
        a: answer,
        steps,
        status: r.complete ? '' : r.status || 'streaming',
        model: r.model,
      };
    },
    [],
  );

  // Fetch the latest committed window fresh (no cache — positional ids drift).
  const loadWindow = useCallback(async () => {
    const ids = await api.getHistoryIds(agentId);
    const conversationId = String(ids.conversation_id ?? '');
    const maxId = Number(ids.id ?? 0);
    const hist = await api.getCurrentHistory(agentId, { limit: WINDOW, conversationId });
    const turns = normalizeHistoryTurns(buildTurnsFromRawItems(hist.items ?? []));
    convRef.current = conversationId;
    maxIdRef.current = maxId;
    committedMinRef.current = turns.length ? Number(turns[0].history_id ?? 0) : 0;
    setCommitted(turns);
    setExhausted(!hist.has_more);
  }, [agentId]);

  // Poll reply.json: stitch/clear the live tail, reconcile when maxId advances.
  const pollReply = useCallback(async () => {
    if (!aliveRef.current) return;
    const gen = pollGenRef.current;
    let complete = true;
    // Route the polled reply through the same buffer + typewriter as the WS path
    // so the fallback is smoothed too (no chunky full-snapshot setLiveTurn).
    const clearLive = () => {
      wsBufRef.current = null;
      setLiveTurn(null);
    };
    const showReply = (rr: any) => {
      const answer = String(rr.answer ?? '');
      const thinking = String(rr.thinking ?? '');
      if (!answer && !thinking) return clearLive();
      const prev = wsBufRef.current;
      const rid = Number(rr.history_id ?? 0);
      const terminal = !!rr.complete || ['completed', 'error', 'aborted'].includes(String(rr.status ?? '').toLowerCase());
      // KEEP-LONGER guard: the poll snapshot (reply.json) lags the WS delta stream,
      // so for the SAME turn it can report fewer chars than WS already accumulated.
      // Overwriting then made the reply text oscillate grow→shrink→grow ("stream
      // 不停刷新"). Never shrink a same-turn answer/thinking unless the turn is
      // terminal (final snapshot wins).
      const sameTurn = !!prev && rid === prev.historyId;
      const keep = (incoming: string, acc: string) => (terminal || incoming.length >= acc.length ? incoming : acc);
      wsBufRef.current = {
        turnId: String(rr.turn_id ?? prev?.turnId ?? ''),
        historyId: rid,
        conversationId: String(rr.conversation_id ?? convRef.current),
        answer: sameTurn ? keep(answer, prev!.answer) : answer,
        thinking: sameTurn ? keep(thinking, prev!.thinking) : thinking,
        status: String(rr.status ?? (terminal ? 'completed' : 'streaming')),
      };
      // Always DRAIN through the typewriter — never snap. A fast agent (or a
      // WS-degraded poll) can hand us the whole answer in one shot; snapping it
      // makes the inverted list lurch (the "跳一跳"). The ~470ms drain finishes
      // well before the idle re-poll, and the committed migration clears the tail
      // once the turn lands, so the full text is never lost.
      smoothFnsRef.current.kick();
    };
    try {
      const r = await api.getCurrentReply(agentId, convRef.current);
      complete = !!r.complete;
      // Cross-session guard: never stitch a reply from another conversation
      // onto this window. If the active conversation changed, reload fresh.
      const replyConv = String(r.reply_conversation_id ?? r.conversation_id ?? '');
      if (replyConv && convRef.current && replyConv !== convRef.current) {
        if (!reconcilingRef.current) {
          reconcilingRef.current = true;
          clearLive();
          await loadWindow().catch(() => {});
          reconcilingRef.current = false;
        }
      } else {
        const committedMax = maxIdRef.current;
        const replyId = Number(r.history_id ?? 0);
        if (replyId <= committedMax) {
          clearLive(); // answer already migrated into committed
        } else if (replyId === committedMax + 1) {
          showReply(r); // normal: stitch onto q_last
        } else if (!reconcilingRef.current) {
          // replyId > committedMax + 1 → new turn(s) committed since last load;
          // window is stale → reconcile by reloading it fresh.
          reconcilingRef.current = true;
          await loadWindow().catch(() => {});
          reconcilingRef.current = false;
          if (replyId === maxIdRef.current + 1) showReply(r);
          else clearLive();
        }
      }
    } catch {
      // transient — keep polling
    } finally {
      // Only reschedule if this loop is still the current generation — a kick
      // (new send / resume) bumps pollGenRef and starts a fresh loop.
      if (aliveRef.current && gen === pollGenRef.current) {
        pollTimer.current = setTimeout(pollReply, complete ? POLL_IDLE_MS : POLL_ACTIVE_MS);
      }
    }
  }, [agentId, loadWindow, liveTurnFromReply]);

  // Restart the reply poll immediately (invalidating any in-flight loop) — used
  // right after a send so the new q / its streaming reply surface without
  // waiting out the idle interval.
  const kickPoll = useCallback(() => {
    pollGenRef.current += 1;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    if (aliveRef.current) pollReply();
  }, [pollReply]);

  // Render the live tail from the REVEALED prefix (shownRef) of the buffer.
  const renderLive = useCallback(() => {
    const b = wsBufRef.current;
    if (!b) {
      setLiveTurn(null);
      return;
    }
    const s = shownRef.current;
    const aShown = b.answer.slice(0, s.aLen);
    const tShown = b.thinking.slice(0, s.tLen);
    const terminal = b.status === 'completed' || b.status === 'error' || b.status === 'aborted';
    const steps: HistoryStep[] = [];
    if (tShown) steps.push({ type: 'thinking', text: tShown });
    if (aShown) steps.push({ type: 'text', text: aShown });
    if (!steps.length && terminal) {
      setLiveTurn(null);
      return;
    }
    setLiveTurn({
      history_id: b.historyId,
      conversation_id: b.conversationId,
      role: 'assistant',
      q: '',
      text: '',
      a: aShown,
      steps,
      status: terminal ? '' : b.status || 'streaming',
    });
  }, []);

  // One animation frame: reveal more of the buffer toward the target length.
  const smoothTick = useCallback(() => {
    rafRef.current = null;
    const b = wsBufRef.current;
    if (!b) {
      setLiveTurn(null);
      return;
    }
    const s = shownRef.current;
    const tk = String(b.historyId);
    if (s.turnId !== tk) {
      s.turnId = tk;
      s.aLen = 0;
      s.tLen = 0;
      s.aFrac = 0;
      s.tFrac = 0;
    }
    const targetA = b.answer.length;
    const targetT = b.thinking.length;
    // Real stream cadence (measured): ~20 chars every ~480ms. To read as
    // CONTINUOUS typing rather than a pulse, reveal the backlog over ~DRAIN_MS so
    // each chunk finishes about when the next arrives. Fractional accumulation
    // lets us go below 1 char/frame; a big backlog (reconnect) drains fast since
    // rate = gap/frames scales with the gap.
    const DRAIN_FRAMES = 28; // ~470ms at 60fps
    const advance = (len: number, frac: number, target: number): [number, number] => {
      if (len >= target) return [target, 0];
      const rate = Math.max(0.4, (target - len) / DRAIN_FRAMES);
      const acc = frac + rate;
      const step = Math.floor(acc);
      return [Math.min(target, len + step), acc - step];
    };
    [s.aLen, s.aFrac] = advance(s.aLen, s.aFrac, targetA);
    [s.tLen, s.tFrac] = advance(s.tLen, s.tFrac, targetT);
    renderLive();
    if (s.aLen < targetA || s.tLen < targetT) {
      rafRef.current = requestAnimationFrame(smoothTick);
    } else if (pendingFinalizeRef.current) {
      // Caught up to a finished turn → refresh committed, but ONLY drop the tail
      // if committed actually owns this answer now. Mobile keeps the finished
      // answer in reply.json until the NEXT turn migrates it (§5); clearing the
      // tail before that would make the just-finished answer vanish.
      pendingFinalizeRef.current = false;
      loadWindow()
        .catch(() => {})
        .finally(() => {
          const b = wsBufRef.current;
          if (!b || Number(b.historyId || 0) <= maxIdRef.current) {
            wsBufRef.current = null;
            setLiveTurn(null);
          }
        });
    }
  }, [renderLive, loadWindow]);

  // Ensure the typewriter loop is running (no-op if already animating).
  const kickSmooth = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(smoothTick);
  }, [smoothTick]);

  // Reveal the whole buffer immediately (no animation) — for seeding / finalize.
  const snapLive = useCallback(() => {
    const b = wsBufRef.current;
    if (!b) {
      setLiveTurn(null);
      return;
    }
    shownRef.current = { turnId: String(b.historyId), aLen: b.answer.length, tLen: b.thinking.length, aFrac: 0, tFrac: 0 };
    renderLive();
  }, [renderLive]);

  // Expose the typewriter to the poll fallback (which is defined above).
  smoothFnsRef.current = { kick: kickSmooth, snap: snapLive };

  // On WS connect, seed the buffer from any in-flight reply so subsequent deltas
  // append onto it instead of starting from empty (we may connect mid-stream).
  const seedBufFromReply = useCallback(async () => {
    try {
      const r = await api.getCurrentReply(agentId, convRef.current);
      const replyConv = String(r.reply_conversation_id ?? r.conversation_id ?? '');
      if (replyConv && convRef.current && replyConv !== convRef.current) return;
      const replyId = Number(r.history_id ?? 0);
      const answer = String(r.answer ?? '');
      const thinking = String(r.thinking ?? '');
      // Tail mirrors reply.json whether streaming OR complete. A finished last
      // turn still lives ONLY in reply.json until the NEXT turn migrates it
      // (INV-5 / §5) — dropping it on `complete` is exactly what made an
      // already-finished answer vanish on open ("只有问题没答案"). Skip only when
      // it's already migrated into committed (replyId<=committedMax) or empty.
      if (replyId <= maxIdRef.current || (!answer && !thinking)) {
        wsBufRef.current = null;
        return;
      }
      wsBufRef.current = {
        turnId: String((r as any).turn_id ?? ''),
        historyId: replyId,
        conversationId: String(r.conversation_id ?? convRef.current),
        answer,
        thinking,
        status: String(r.status ?? (r.complete ? 'completed' : 'streaming')),
      };
      snapLive(); // first paint of already-existing content (not a mid-stream snap)
    } catch {
      /* transient */
    }
  }, [agentId, snapLive]);

  // Consume a pushed stream event: accumulate deltas, finalize on current_updated.
  const handleStreamEvent = useCallback(
    (e: StreamEvent) => {
      if (e.conversationId && convRef.current && e.conversationId !== convRef.current) return; // other session
      const eid = Number(e.historyId || 0);
      const cur = wsBufRef.current;
      const curId = cur ? cur.historyId : 0;
      // ── MONOTONIC TURN LOCK ──────────────────────────────────────────────────
      // The WS can INTERLEAVE events from an older still-finishing turn (e.g. a busy
      // agent's own concurrent turn) and the newest turn. Without a lock the single
      // buffer flips identity every event → the typewriter's turn-key flips → the
      // revealed length resets to ~0 each frame → the reply text never accumulates,
      // it just thrashes (the "stream 不停刷新"). Rule: lock onto the NEWEST turn
      // (highest historyId). DROP any event whose historyId is OLDER than the locked
      // turn; an event with a HIGHER id is a genuinely newer turn → switch to it.
      if (eid && curId && eid < curId) return; // older turn → ignore entirely
      const newer = !cur || (!!eid && eid > curId); // start a fresh turn buffer

      if (e.kind === 'current_updated') {
        const terminal = e.status === 'completed' || e.status === 'error' || e.status === 'aborted';
        // Anti-shrink WITHIN the locked turn (deltas can outrun the snapshot). A
        // newer turn resets cleanly (base=null) so a fresh reply never streams onto
        // the previous one. Terminal snapshot is authoritative.
        const base = newer ? null : cur;
        const keepLonger = (snap: string, acc: string) => (terminal || snap.length >= acc.length ? snap : acc);
        wsBufRef.current = {
          turnId: e.turnId || (newer ? '' : cur?.turnId ?? ''),
          historyId: eid || curId,
          conversationId: e.conversationId || convRef.current,
          answer: keepLonger(e.answer, base?.answer ?? ''),
          thinking: keepLonger(e.thinking, base?.thinking ?? ''),
          status: e.status,
        };
        pendingFinalizeRef.current = terminal;
        kickSmooth();
        return;
      }
      let b = cur;
      if (!b || newer) {
        b = { turnId: e.turnId, historyId: eid, conversationId: e.conversationId || convRef.current, answer: '', thinking: '', status: '' };
        wsBufRef.current = b;
      }
      if (e.turnId) b.turnId = e.turnId;
      if (eid) b.historyId = eid;
      if (e.conversationId) b.conversationId = e.conversationId;
      if (e.kind === 'ai_chunk') b.answer += e.delta; // VERBATIM — whitespace matters
      else if (e.kind === 'thinking_chunk') b.thinking += e.delta;
      else if (e.kind === 'status_change') b.status = e.status;
      kickSmooth();
    },
    [loadWindow, snapLive, kickSmooth],
  );

  // WS up → stop the fallback poll + seed; WS down → resume polling.
  const handleConnected = useCallback(
    (connected: boolean) => {
      wsConnectedRef.current = connected;
      if (connected) {
        pollGenRef.current += 1;
        if (pollTimer.current) {
          clearTimeout(pollTimer.current);
          pollTimer.current = null;
        }
        seedBufFromReply();
      } else if (aliveRef.current) {
        kickPoll();
      }
    },
    [seedBufFromReply, kickPoll],
  );

  // Open / re-focus: load the committed window, then poll the reply tail.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      aliveRef.current = true;
      setLoading(true);
      setLiveTurn(null);
      wsBufRef.current = null;
      let closeStream: (() => void) | null = null;
      (async () => {
        try {
          await loadWindow();
          if (mounted) {
            setError(null);
            scrollToBottomSoonRef.current(); // open at the newest turn
          }
        } catch (e: any) {
          if (mounted) setError(String(e?.message ?? e));
        } finally {
          if (mounted) setLoading(false);
        }
        if (!mounted || !aliveRef.current) return;
        pollReply(); // immediate fallback; the WS stops it once it connects
        const { serverUrl, token, clientId } = useAuthStore.getState();
        if (serverUrl && token) {
          closeStream = openChatStream({
            serverUrl,
            token,
            agentId,
            clientId: clientId || 'mobile',
            onEvent: handleStreamEvent,
            onConnected: handleConnected,
          });
        }
      })();
      return () => {
        mounted = false;
        aliveRef.current = false;
        wsConnectedRef.current = false;
        wsBufRef.current = null;
        shownRef.current = { turnId: '', aLen: 0, tLen: 0, aFrac: 0, tFrac: 0 };
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (closeStream) closeStream();
        if (pollTimer.current) clearTimeout(pollTimer.current);
        pollTimer.current = null;
      };
    }, [agentId, loadWindow, pollReply, handleStreamEvent, handleConnected]),
  );

  // Pause polling in the background; resume immediately on return.
  useEffect(() => {
    const onChange = (s: AppStateStatus) => {
      if (s === 'active') {
        if (!aliveRef.current) {
          aliveRef.current = true;
          if (!wsConnectedRef.current) pollReply(); // WS (if up) reconnects on its own
        }
      } else {
        aliveRef.current = false;
        if (pollTimer.current) clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [pollReply]);

  // A new send: show the q instantly, then reload the window + kick the poll so
  // the committed q and its streaming reply catch up fast.
  useEffect(() => {
    if (!pending) {
      if (pending === null) setOptimistic(null); // explicit clear (e.g. send failed)
      return;
    }
    if (pending.nonce === lastNonceRef.current) return;
    lastNonceRef.current = pending.nonce;
    optimisticKeyRef.current = `opt-${pending.nonce}`; // unique → 2nd send re-anchors
    setOptimistic(pending.text);
    // Don't scroll-to-bottom here: the optimistic q ('opt') appearing triggers the
    // anchor effect, which pins THIS new q to the TOP of the viewport with its reply
    // streaming below it. Don't reload committed either — a mid-send window reload
    // changes content height and jolts the scroll; poll/reconcile folds it in.
    kickPoll();
  }, [pending, loadWindow, kickPoll]);

  // Drop the optimistic q once the real one lands as the newest committed turn.
  // (Not merely when a reply streams — a prior turn may still be streaming when
  // the new q is sent, and clearing then would hide it.)
  useEffect(() => {
    if (optimistic == null) return;
    const newest = committed[committed.length - 1];
    if (newest && (newest.q ?? '') === optimistic) setOptimistic(null);
  }, [committed, optimistic]);

  // Pull-to-refresh = load an older page of committed turns (prepend).
  const loadOlder = useCallback(async () => {
    if (refreshing || exhausted || !committedMinRef.current) return;
    setRefreshing(true);
    try {
      const hist = await api.getCurrentHistory(agentId, {
        limit: WINDOW,
        before: committedMinRef.current,
        conversationId: convRef.current,
      });
      const older = normalizeHistoryTurns(buildTurnsFromRawItems(hist.items ?? []));
      if (!older.length) {
        setExhausted(true);
      } else {
        committedMinRef.current = Number(older[0].history_id ?? committedMinRef.current);
        setCommitted((prev) => normalizeHistoryTurns([...older, ...prev]));
        setExhausted(!hist.has_more);
      }
    } catch {
      // Ignore — user can swipe again.
    } finally {
      setRefreshing(false);
    }
  }, [agentId, refreshing, exhausted]);

  // The just-sent question, rendered instantly at the bottom with a typing
  // indicator until the real committed turn (or its streaming reply) arrives.
  const optimisticTurn = useMemo<HistoryTurn | null>(
    () =>
      optimistic
        ? {
            history_id: (maxIdRef.current || 0) + 2, // strictly newest
            conversation_id: convRef.current,
            role: 'user',
            q: optimistic,
            text: '',
            a: '',
            steps: [],
            status: 'pending',
          }
        : null,
    [optimistic],
  );

  // Inverted FlatList: data[0] = visual bottom = newest. Optimistic q (newest),
  // then the live reply tail, then committed newest→oldest.
  // Recap-on-return is system noise: a harness-only user turn ("The user stepped
  // away… Recap…" / continuation banner) plus the assistant recap it triggers.
  // The instruction itself stays as a folded "system" pill (QuestionBubble folds
  // it); here we DROP its assistant response. liveIsRecap flags when the pending
  // recap response is still in the live reply tail (so we suppress that too).
  const { displayCommitted, liveIsRecap } = useMemo(() => {
    const out: HistoryTurn[] = [];
    let pendingRecap = false;
    for (const t of committed) {
      if (t.role === 'user' && t.q && t.q.trim()) {
        const p = splitLeadingHarnessBlocks(t.q);
        pendingRecap = !p.remaining && p.blocks.length > 0;
        out.push(t);
      } else if (t.role === 'assistant' && pendingRecap && ((t.a && t.a.trim()) || (t.steps?.length ?? 0) > 0)) {
        pendingRecap = false; // this assistant turn IS the recap response → drop
      } else {
        out.push(t); // empty turns keep pendingRecap alive (don't consume it)
      }
    }
    return { displayCommitted: out, liveIsRecap: pendingRecap };
  }, [committed]);

  // NON-inverted: data = committed turns in chronological order (oldest→newest),
  // FROZEN during streaming (changes only when `displayCommitted` changes). The
  // live tail renders separately as the list FOOTER (bottom); stick-to-bottom
  // scroll follows it. This replaces the inverted FlatList, whose scroll-recompute
  // on every content growth caused the ±200px bounce ("跳").
  const data = useMemo(() => displayCommitted, [displayCommitted]);

  // The optimistic q + live answer render SEPARATELY as the list FOOTER (visual
  // bottom), so their per-frame growth never re-renders the committed list. Order:
  // question then answer (answer newest). The optimistic q is dropped once it
  // lands in committed as q_last (avoids the duplicate).
  const tailTurns = useMemo(() => {
    const newestCommittedQ = [...displayCommitted].reverse().find((t) => t.role === 'user')?.q;
    const optimisticLanded =
      !!optimisticTurn && !!newestCommittedQ && newestCommittedQ === optimisticTurn.q;
    const arr: HistoryTurn[] = [];
    if (optimisticTurn && !optimisticLanded) arr.push(optimisticTurn);
    if (liveTurn && !liveIsRecap) arr.push(liveTurn);
    return arr;
  }, [displayCommitted, liveIsRecap, liveTurn, optimisticTurn]);

  // ── Top anchor (port of cicy-code CurrentHistoryView §"new q to top") ─────────
  const domNode = useCallback((): any => {
    const sv: any = scrollRef.current;
    return sv && typeof sv.getScrollableNode === 'function' ? sv.getScrollableNode() : null;
  }, []);
  const applyAnchorSpacerHeight = useCallback((h: number) => {
    const n = Math.max(0, Math.round(h));
    if (anchorSpacerHeightRef.current === n) return;
    anchorSpacerHeightRef.current = n;
    setAnchorSpacerHeight(n);
  }, []);
  const clearScheduledScrolls = useCallback(() => {
    const s = scheduledScrollRef.current;
    if (!s) return;
    cancelAnimationFrame(s.raf as unknown as number);
    s.timers.forEach((t) => clearTimeout(t));
    scheduledScrollRef.current = null;
  }, []);
  const runScheduledScroll = useCallback(
    (s: { raf: number; timers: number[] }) => {
      clearScheduledScrolls();
      scheduledScrollRef.current = s;
    },
    [clearScheduledScrolls],
  );
  useEffect(() => () => clearScheduledScrolls(), [clearScheduledScrolls]);

  // The key of the newest user question across the rendered sequence (committed
  // turns, then the optimistic q in the tail). data-turn-key on each rendered turn
  // must match these so querySelector can find the anchor target.
  const computeLastUserKey = useCallback((): string => {
    const newestCommittedQ = [...displayCommitted].reverse().find((t) => t.role === 'user')?.q;
    const optimisticLanded = !!optimisticTurn && !!newestCommittedQ && newestCommittedQ === optimisticTurn.q;
    if (optimisticTurn && !optimisticLanded) return optimisticKeyRef.current;
    for (let i = displayCommitted.length - 1; i >= 0; i -= 1) {
      const t = displayCommitted[i];
      if (t.role === 'user') return String(t.history_id ?? `u-${i}`);
    }
    return '';
  }, [optimisticTurn, displayCommitted]);

  // onScroll: track whether the user is near the bottom (stick) and load earlier
  // near the top. A genuine user scroll updates stick; the anchor effect owns the
  // programmatic pinning.
  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y;
      shouldStickBottomRef.current = contentSize.height - y - layoutMeasurement.height <= 80;
      if (y <= 80) loadOlder();
    },
    [loadOlder],
  );
  // w-10064's RN tip: re-assert the anchor on content-size change (markdown/code
  // reflow shifts offsetTop) — more accurate than timers alone. Keeps the in-flight
  // q pinned to the top as its reply grows; else follows the bottom if stuck there.
  const onContentSizeChange = useCallback(() => {
    const node = domNode();
    if (!node) return;
    if (activeSpacerTurnKeyRef.current) pinTurnTop(node, activeSpacerTurnKeyRef.current);
    else if (shouldStickBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [domNode]);

  // Open / conversation-switch: reset anchor state so the effect's first-load branch
  // scrolls to the newest turn (bottom) and marks it anchored (no yank-to-top on open).
  const resetAnchorToBottom = useCallback(() => {
    didInitialScrollRef.current = false;
    activeSpacerTurnKeyRef.current = '';
    anchoredQKeyRef.current = '';
    applyAnchorSpacerHeight(0);
  }, [applyAnchorSpacerHeight]);
  scrollToBottomSoonRef.current = resetAnchorToBottom;

  // The anchor effect: pin a new q to the top and size the bottom spacer once so a
  // short q+reply can still sit at top. While the reply is in flight it does NOTHING
  // (the q stays put because the reply grows below it; onContentSizeChange re-pins
  // idempotently on any structural shift). A unique q key per send re-fires this for
  // a 2nd consecutive send (fixes the ~138px drift). Runs in rAF so layout is settled.
  useEffect(() => {
    if (!open || loading) return;
    const frame = requestAnimationFrame(() => {
      const node = domNode();
      if (!node) return;

      // loadOlder prepend → keep the user's position, don't anchor.
      if (preserveScrollOffsetRef.current) {
        preserveScrollOffsetRef.current = false;
        didInitialScrollRef.current = true;
        return;
      }

      const lastUserKey = computeLastUserKey();

      // First load: show the newest turn (bottom), mark it anchored so we don't
      // immediately yank it to the top.
      if (!didInitialScrollRef.current) {
        anchoredQKeyRef.current = lastUserKey;
        applyAnchorSpacerHeight(0);
        runScheduledScroll(scheduleBottom(node));
        shouldStickBottomRef.current = true;
        didInitialScrollRef.current = true;
        return;
      }

      // A NEW question appeared → pin it to the top + open the bottom spacer.
      if (lastUserKey && lastUserKey !== anchoredQKeyRef.current) {
        const target = findTurnEl(node, lastUserKey);
        if (target) {
          anchoredQKeyRef.current = lastUserKey;
          activeSpacerTurnKeyRef.current = lastUserKey;
          applyAnchorSpacerHeight(Math.max(0, node.clientHeight - target.offsetHeight - 16));
          runScheduledScroll(scheduleTurnTop(node, lastUserKey));
          shouldStickBottomRef.current = false;
          return;
        }
      }

      // A q with its reply still settling. While the reply is IN FLIGHT we hold the
      // spacer perfectly steady and do NOT re-pin per frame: the q stays at the top
      // on its own because the reply grows BELOW it (scrollTop unchanged), and any
      // structural shift is re-pinned idempotently by onContentSizeChange. Resizing
      // the spacer or re-pinning every typewriter frame is exactly what made it jitter
      // ("一直在跳") — the state-backed spacer height lags the pin by a frame.
      if (activeSpacerTurnKeyRef.current) {
        const key = activeSpacerTurnKeyRef.current;
        const qTop = turnTopInContent(node, key);
        if (qTop == null) {
          activeSpacerTurnKeyRef.current = '';
          return;
        }
        const lastCommitted = displayCommitted[displayCommitted.length - 1];
        const replyInFlight = !!liveTurn || isActiveAssistantStatus(String(lastCommitted?.status ?? ''));
        if (replyInFlight) return; // steady — no resize, no re-pin → no jitter
        // Reply settled: shrink the spacer once to remove any blank below the reply,
        // and release the anchor when the content has filled the viewport.
        const belowQ = node.scrollHeight - anchorSpacerHeightRef.current - qTop;
        const measured = Math.max(0, node.clientHeight - belowQ - 16);
        applyAnchorSpacerHeight(measured);
        if (measured <= 0) activeSpacerTurnKeyRef.current = '';
        return;
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loading, displayCommitted, liveTurn, optimistic]);

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

  const isEmpty = data.length === 0 && tailTurns.length === 0;
  return (
    // NON-virtualized scroll container (windowed to WINDOW items, so DOM count is
    // bounded). A single overflow scroll <div> on web — required for the top-anchor
    // mechanism (precise scrollTop + a dynamic bottom spacer), matching cicy-code.
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={styles.list}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onContentSizeChange={onContentSizeChange}
    >
      {/* Load-earlier indicator at the TOP (non-inverted). */}
      {isEmpty ? null : refreshing ? (
        <View style={styles.loadMoreRow}>
          <ActivityIndicator size="small" color={theme.textMuted} />
        </View>
      ) : exhausted ? (
        <View style={styles.loadMoreRow}>
          <Text variant="caption" tone="faint">
            · beginning of history ·
          </Text>
        </View>
      ) : null}

      {isEmpty ? (
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
      ) : null}

      {/* Committed turns — each carries data-turn-key so the anchor can find a q. */}
      {data.map((t, i) => (
        <View
          key={`row-${t.history_id ?? t.turn_id ?? t.ts ?? i}`}
          {...({ dataSet: { turnKey: String(t.history_id ?? `u-${i}`) } } as any)}
        >
          <Turn turn={t} isLast={false} />
        </View>
      ))}

      {/* Live tail (optimistic q 'opt' + streaming answer 'live') appended in the
          SAME scroll container, right after committed — the q+reply are adjacent. */}
      {tailTurns.map((t, i) => {
        const key = t.status === 'pending' ? optimisticKeyRef.current : 'live';
        return (
          <View key={key} {...({ dataSet: { turnKey: key } } as any)}>
            <Turn turn={t} isLast={i === tailTurns.length - 1} />
          </View>
        );
      })}

      {/* Dynamic bottom spacer: makes room so a short q+reply can sit at the top;
          sized once when the q appears, shrunk once after the reply settles. */}
      <View {...({ dataSet: { anchorSpacer: '1' } } as any)} style={{ height: anchorSpacerHeight }} />
    </ScrollView>
  );
}

// Folded harness/system notice — a tiny centered "system" pill (tap to expand),
// matching web's SystemNoticeCard. Repeated reminders read as subtle separators
// instead of cluttering the conversation.
function SystemNoticeCard({ text }: { text: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <View style={{ alignItems: 'center', alignSelf: 'stretch' }}>
      <PressableScale onPress={() => setOpen((o) => !o)} hitSlop={6} style={styles.sysPill}>
        <Text variant="caption" tone="faint" style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {open ? '▾' : '▸'} system
        </Text>
      </PressableScale>
      {open ? (
        <View style={[styles.sysBody, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}>
          <Text variant="caption" tone="muted" selectable>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// User question bubble = web's CollapsibleQ: peel leading harness blocks
// (system-reminder / recap / continuation / command echoes) into a folded
// SystemNoticeCard, render only the real question as the bubble.
function QuestionBubble({ text }: { text: string }) {
  const theme = useTheme();
  const { blocks, remaining } = useMemo(() => splitLeadingHarnessBlocks(text), [text]);
  if (!remaining && !blocks.length) return null;
  return (
    <View style={{ gap: spacing.sm }}>
      {blocks.length ? <SystemNoticeCard text={blocks.join('\n\n')} /> : null}
      {remaining ? (
        <View style={styles.qRow}>
          <View style={[styles.qBubble, { backgroundColor: theme.accent }]}>
            <Text style={{ color: theme.accentText, fontSize: 15, lineHeight: 22 }}>{remaining}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Turn({ turn, isLast }: { turn: HistoryTurn; isLast: boolean }) {
  const theme = useTheme();
  // Harness-injected system/developer notice → folded card (matches web).
  if (turn.role === 'system') return <SystemNoticeCard text={turn.text || ''} />;
  const status = (turn.status ?? '').toLowerCase();
  const streaming = isLast && (status === 'streaming' || status === 'pending' || status === 'tool_use');

  // A pure-question turn (no answer yet) must NOT render the empty answer block —
  // its leading gap left a large blank between the q and the next (answer) turn
  // ("q和a 之间很大间隔"). Only render the answer section when it has content.
  const hasAnswer = (turn.steps?.length ?? 0) > 0 || !!turn.a || streaming;
  return (
    <View style={{ gap: spacing.md }}>
      {turn.q ? <QuestionBubble text={turn.q} /> : null}

      {hasAnswer ? (
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
      ) : null}
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

type ToolData = { name?: string; arg?: string; result?: string };

// A one-line preview of the call for the collapsed header: prefer a meaningful
// field out of a JSON arg (command / path / pattern …), else the arg's first
// line. Mirrors cicy-code's toolHeadline intent.
function toolHeadline(arg?: string): string {
  const s = String(arg ?? '').trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      const cand =
        o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.description ?? '';
      if (cand) return String(cand).split('\n')[0].slice(0, 140);
    } catch {}
  }
  return s.split('\n')[0].slice(0, 140);
}

const TOOL_BODY_MAX = 4000; // cap expanded text so a huge result can't blow up the row

function ToolStrip({ tools }: { tools: ToolData[] }) {
  return (
    <View style={{ gap: spacing.sm }}>
      {tools.map((t, i) => (
        <ToolCard key={i} tool={t} />
      ))}
    </View>
  );
}

// Complete tool card (ported from cicy-code's ToolCard): collapsed shows the
// tool name + a one-line arg headline; tapping expands the full command/args
// and the result.
function ToolCard({ tool }: { tool: ToolData }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const name = String(tool?.name ?? 'tool').trim() || 'tool';
  const arg = String(tool?.arg ?? '').trim();
  const result = String(tool?.result ?? '').trim();
  const headline = toolHeadline(arg);
  // Skip the arg block when it's just the single-line headline repeated.
  const showArg = !!arg && arg !== headline;
  const hasBody = showArg || !!result;
  const clamp = (s: string) => (s.length > TOOL_BODY_MAX ? s.slice(0, TOOL_BODY_MAX) + '\n…(truncated)' : s);

  return (
    <View style={[styles.toolCard, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <PressableScale
        onPress={() => hasBody && setOpen((v) => !v)}
        haptic={hasBody}
        scaleTo={0.99}
        style={styles.toolHeader}
      >
        <Text variant="caption" style={{ color: theme.ok }}>
          ✓
        </Text>
        <View style={[styles.toolNameChip, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {name}
          </Text>
        </View>
        {headline ? (
          <Text variant="caption" tone="faint" numberOfLines={1} style={[styles.toolHeadline, typeScale.mono]}>
            {headline}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {hasBody ? (
          <Text variant="caption" tone="faint">
            {open ? '▾' : '▸'}
          </Text>
        ) : null}
      </PressableScale>

      {open ? (
        <View style={styles.toolBody}>
          {showArg ? <ToolCode text={clamp(arg)} color={theme.textMuted} /> : null}
          {result ? <ToolCode text={clamp(result)} color={theme.text} /> : null}
        </View>
      ) : null}
    </View>
  );
}

// Tool arg/result block: a horizontally-scrolling code box. Real newlines are
// preserved but lines never SOFT-wrap (white-space: pre on web; the horizontal
// ScrollView gives overflow-x: auto on web and native), so a long command or
// wide output scrolls sideways instead of inflating the card's height.
function ToolCode({ text, color }: { text: string; color: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.toolCode, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
      <ScrollView horizontal style={{ width: '100%' }}>
        <Text selectable style={[typeScale.mono, { color }, Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as any) : null]}>
          {text}
        </Text>
      </ScrollView>
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
          <MarkdownBlocks key={i} text={seg.text} theme={theme} />
        ),
      )}
    </View>
  );
}

// Inline markdown within a single line: **bold**, `code`, [label](url),
// *italic* / _italic_. Returns an array of strings + styled <Text> nodes that
// nest inside a parent <Text> (RN supports nested Text for inline runs).
// Emphasis edges must be non-space, so "a * b" / "2 * 3" don't become italics.
// `_` is intentionally NOT italic: identifiers like CICY_PUBLIC_URL / run_worker_first
// are far more common than underscore-emphasis and were being mangled.
const INLINE_RE = /(`[^`]+`)|(\*\*[^\s*](?:[^*]*[^\s*])?\*\*)|(\[[^\]]+\]\([^)]+\))|(\*[^\s*](?:[^*\n]*[^\s*])?\*)/g;

function renderInline(text: string, theme: ReturnType<typeof useTheme>, kp: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <Text key={`${kp}c${i}`} style={[typeScale.mono, { color: theme.text, backgroundColor: theme.surfaceMuted }]}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith('**')) {
      out.push(
        <Text key={`${kp}b${i}`} style={{ fontWeight: '700' }}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = link ? link[1] : tok;
      const url = link ? link[2] : '';
      out.push(
        <Text
          key={`${kp}l${i}`}
          style={{ color: theme.accent, textDecorationLine: 'underline' }}
          onPress={url ? () => Linking.openURL(url).catch(() => {}) : undefined}
        >
          {label}
        </Text>,
      );
    } else {
      out.push(
        <Text key={`${kp}i${i}`} style={{ fontStyle: 'italic' }}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = INLINE_RE.lastIndex;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Block-level markdown for a non-code text segment: headings, bullet / numbered
// lists, blockquotes, horizontal rules, and paragraphs (consecutive plain lines
// kept together). No new deps — react-native-markdown-display doesn't play well
// with RN 0.83 / React 19, so this is a small purpose-built renderer.
function MarkdownBlocks({ text, theme }: { text: string; theme: ReturnType<typeof useTheme> }) {
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const k = blocks.length;
    blocks.push(
      <Text key={`p${k}`} variant="body" selectable>
        {renderInline(para.join('\n'), theme, `p${k}`)}
      </Text>,
    );
    para = [];
  };
  for (const line of text.split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const hr = /^\s*([-*_])\1{2,}\s*$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const num = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const k = blocks.length + 1; // unique-ish key after the flush below
    if (h) {
      flushPara();
      const lvl = h[1].length;
      blocks.push(
        <Text
          key={`h${k}`}
          variant="body"
          selectable
          style={{ fontWeight: '700', fontSize: lvl === 1 ? 18 : lvl === 2 ? 16 : 14.5, marginTop: 2 }}
        >
          {renderInline(h[2], theme, `h${k}`)}
        </Text>,
      );
    } else if (hr) {
      flushPara();
      blocks.push(<View key={`hr${k}`} style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginVertical: 2 }} />);
    } else if (bullet) {
      flushPara();
      blocks.push(
        <View key={`bl${k}`} style={styles.mdListRow}>
          <Text variant="body">•</Text>
          <Text variant="body" selectable style={{ flex: 1, minWidth: 0 }}>
            {renderInline(bullet[1], theme, `bl${k}`)}
          </Text>
        </View>,
      );
    } else if (num) {
      flushPara();
      blocks.push(
        <View key={`nu${k}`} style={styles.mdListRow}>
          <Text variant="body">{num[1]}.</Text>
          <Text variant="body" selectable style={{ flex: 1, minWidth: 0 }}>
            {renderInline(num[2], theme, `nu${k}`)}
          </Text>
        </View>,
      );
    } else if (quote) {
      flushPara();
      blocks.push(
        <View key={`q${k}`} style={[styles.mdQuote, { borderColor: theme.border }]}>
          <Text variant="body" tone="muted" selectable>
            {renderInline(quote[1], theme, `q${k}`)}
          </Text>
        </View>,
      );
    } else if (line.trim() === '') {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushPara();
  return <View style={{ gap: 4 }}>{blocks}</View>;
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

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing['2xl'],
    gap: spacing.lg,
    flexGrow: 1,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing['2xl'] },
  qRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  sysPill: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 999, opacity: 0.8 },
  sysBody: {
    alignSelf: 'stretch',
    marginTop: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
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
  toolCard: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  toolNameChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
  },
  // minWidth:0 lets the flex child actually shrink so numberOfLines={1} can
  // ellipsize on react-native-web (default min-width:auto would overflow/wrap).
  toolHeadline: { flex: 1, minWidth: 0, fontSize: 12 },
  toolBody: { paddingHorizontal: spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm },
  mdListRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  mdQuote: { borderLeftWidth: 2, paddingLeft: spacing.sm, opacity: 0.9 },
  toolCode: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  codeBlock: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  loadMoreRow: { alignItems: 'center', paddingVertical: spacing.md },
});
