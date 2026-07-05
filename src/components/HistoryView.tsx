import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, type AppStateStatus, Image, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { api } from '@/src/api/http';
import { assetUri } from '@/src/api/upload';
import i18n from '@/src/i18n';
import type { HistoryStep, HistoryTurn } from '@/src/api/types';
import { buildTurnsFromRawItems, normalizeHistoryTurns, replyItemsToSteps, splitLeadingHarnessBlocks, stripHarnessNoise } from '@/src/lib/historyParse';
import { historyCache } from '@/src/lib/historyCache';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';
import { InlineVideo } from './InlineVideo';
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
  // ENTER-ONLY busy signal to the composer: fired whenever the poll observes an
  // in-flight reply (turn started here or from any other channel). Clearing
  // busy is owned solely by the composer's baseline hysteresis poll.
  onReplyInFlight?: () => void;
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
const CURRENT_HISTORY_POLL_WAIT_MS = 150; // re-check until Part 1 (committed) is ready

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
// Custom smooth scroll (rAF easeOutCubic). RN-Web's ScrollView ignores native
// `scrollTo({behavior:'smooth'})` (it drifts to 0), so we animate scrollTop
// ourselves — this is what makes the q GLIDE to the top instead of hard-jumping.
let __scrollAnim: number | null = null;
function nowMs(): number {
  const g: any = globalThis;
  return g.performance && typeof g.performance.now === 'function' ? g.performance.now() : Date.now();
}
function cancelScrollAnim() {
  if (__scrollAnim != null) { cancelAnimationFrame(__scrollAnim); __scrollAnim = null; }
}
function animateScrollTop(node: any, target: number, ms: number) {
  if (!node) return;
  cancelScrollAnim();
  const start = node.scrollTop || 0;
  const dest = Math.max(0, target);
  const dist = dest - start;
  if (Math.abs(dist) < 2) { node.scrollTop = dest; return; }
  const t0 = nowMs();
  const ease = (p: number) => 1 - Math.pow(1 - p, 3);
  const step = () => {
    const p = Math.min(1, (nowMs() - t0) / ms);
    node.scrollTop = start + dist * ease(p);
    if (p < 1) __scrollAnim = requestAnimationFrame(step);
    else __scrollAnim = null;
  };
  __scrollAnim = requestAnimationFrame(step);
}
function isActiveAssistantStatus(s: string): boolean {
  const v = (s || '').toLowerCase();
  return v === 'streaming' || v === 'pending' || v === 'tool_use' || v === 'running' || v === 'in_progress';
}

// Does this reply answer a REAL user question? The framework makes its own internal
// LLM calls whose replies must NOT show as agent answers to the user:
//   • SUGGESTION MODE  → question starts with "[SUGGESTION MODE…"; reply is the
//     predicted next user input (e.g. "(no suggestion)").
//   • system-reminder / recap  → question is harness-only (no real text after the
//     blocks); reply is often "(silence)".
// Detected via the reply's `question` field (carried by WS current_updated and
// reply.json). Empty/absent question → unknown → treat as real (don't over-suppress).
function replyAnswersRealQuestion(question?: string): boolean {
  const s = String(question ?? '').trim();
  if (!s) return true;
  if (/^\[\s*suggestion mode/i.test(s)) return false;
  return !!splitLeadingHarnessBlocks(s).remaining.trim();
}

export function HistoryView({ agentId, pending, onReplyInFlight }: Props) {
  const theme = useTheme();

  // ── Two-part model (faithful port of cicy-code CurrentHistoryView) ────────────
  // Part 1: committed window (current.json), single-role turns oldest→newest.
  // Part 2: liveTurn (≤1), the in-flight answer polled from reply.json, rendered
  // SEPARATELY right after committed. NO optimistic q, NO consecutive-assistant
  // merge — exactly like web. Single source of truth = reply.json (poll, no WS).
  const [items, setItems] = useState<HistoryTurn[]>([]); // committed, oldest→newest
  const [liveTurn, setLiveTurn] = useState<HistoryTurn | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setConversationId] = useState('');
  const [anchorSpacerHeight, setAnchorSpacerHeight] = useState(0);

  const scrollRef = useRef<ScrollView>(null);
  // Poll/data refs (read by the loop without re-subscribing).
  const convRef = useRef('');
  const maxLoadedIdRef = useRef(0); // largest committed history_id (== q_last id)
  const minLoadedIdRef = useRef(0); // smallest committed id (paging)
  const lastSigRef = useRef(''); // last rendered live-tail signature (skip no-op re-renders)
  const liveTurnIdRef = useRef(''); // backend turn_id of the live tail
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGenRef = useRef(0); // bump to invalidate a stale poll loop's reschedule
  const aliveRef = useRef(false);
  const focusedRef = useRef(false); // screen focused (useFocusEffect) — gates AppState resume
  const reconcilingRef = useRef(false);
  const requestSeqRef = useRef(0);
  const lastNonceRef = useRef(0); // last processed `pending.nonce`
  const onReplyInFlightRef = useRef<typeof onReplyInFlight>(undefined);
  onReplyInFlightRef.current = onReplyInFlight;
  const committedReadyRef = useRef(false); // Part 1 loaded → poll may attach tail
  const firstReplyDoneRef = useRef(false); // Part 2's first poll resolved → reveal

  // Anchor refs (port of web's "new q to top").
  const anchorSpacerHeightRef = useRef(0);
  const anchoredQKeyRef = useRef(''); // q key already pinned to top (re-pins on a NEW q)
  const activeSpacerTurnKeyRef = useRef(''); // q whose reply is in flight → spacer alive
  const replySeenActiveRef = useRef(false); // reply streamed once → only then may spacer shrink
  const didInitialScrollRef = useRef(false);
  const shouldStickBottomRef = useRef(true);
  const preserveScrollOffsetRef = useRef(false); // loadMore prepend → keep position
  const scheduledScrollRef = useRef<{ raf: number; timers: number[] } | null>(null);

  const domNode = useCallback((): any => {
    const sv: any = scrollRef.current;
    const n = sv && typeof sv.getScrollableNode === 'function' ? sv.getScrollableNode() : null;
    // Only return a node we can actually set scrollTop on — i.e. a web DOM
    // element. On native, getScrollableNode() returns a numeric reactTag, and
    // assigning `.scrollTop` on a number throws "cannot create property
    // scrollTop on number" (app crash). Returning null makes every scroll
    // helper no-op on native, exactly as the anchor logic intends.
    return n && typeof n === 'object' && typeof n.scrollTop === 'number' ? n : null;
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

  // ── Part 1: committed window. Always refetched fresh (positional ids drift),
  // but write-through to historyCache so the NEXT open paints instantly from the
  // last-seen frame instead of a spinner. The cache is never trusted as truth —
  // this refetch overwrites it every open.
  const loadWindow = useCallback(async () => {
    const ids = await api.getHistoryIds(agentId);
    const cid = String(ids.conversation_id ?? '');
    const maxId = Number(ids.id ?? 0);
    convRef.current = cid;
    setConversationId(cid);
    if (!cid || maxId <= 0) {
      maxLoadedIdRef.current = 0;
      minLoadedIdRef.current = 0;
      setItems([]);
      setHasMore(false);
      return;
    }
    const hist = await api.getCurrentHistory(agentId, { limit: WINDOW, conversationId: cid });
    const turns = normalizeHistoryTurns(buildTurnsFromRawItems(hist.items ?? []));
    maxLoadedIdRef.current = maxId;
    minLoadedIdRef.current = turns.length ? Number(turns[0].history_id ?? 0) : 0;
    setItems(turns);
    setHasMore(!!hist.has_more);
    if (turns.length) {
      historyCache.put(agentId, {
        conversationId: cid,
        maxId,
        minId: minLoadedIdRef.current,
        hasMore: !!hist.has_more,
        turns,
      });
    }
  }, [agentId]);

  // A newer turn started → append ONLY the new committed tail (maxLoaded, newMax];
  // never re-pull below it (preserves older loaded pages). Port of reconcileTail.
  //
  // Pages BACKWARD from the newest window until the fetched span reaches the
  // already-loaded boundary: a single multi-tool turn can span far more than one
  // WINDOW of ids, and a one-page fetch would leave a GAP that loadMore can never
  // fill (it pages below the OLD min, not into the gap) — the turn then renders
  // with its earlier steps missing until a full reload.
  const reconcileTail = useCallback(async () => {
    try {
      const ids = await api.getHistoryIds(agentId);
      const cid = String(ids.conversation_id ?? '');
      const newMax = Number(ids.id ?? 0);
      if (cid && convRef.current && cid !== convRef.current) return; // rotation → softRebind
      if (newMax <= maxLoadedIdRef.current) return;
      const collected: HistoryTurn[] = [];
      let before: number | undefined;
      // 8 pages ≈ 128 ids per reconcile — runaway guard; anything bigger heals
      // on the next poll round since maxLoadedIdRef only advances on success.
      for (let page = 0; page < 8; page += 1) {
        const hist = await api.getCurrentHistory(agentId, {
          limit: WINDOW,
          conversationId: cid,
          ...(before ? { before } : {}),
        });
        const turns = buildTurnsFromRawItems(hist.items ?? []);
        if (!turns.length) break;
        collected.unshift(...turns);
        const pageMin = Number(turns[0].history_id ?? 0);
        if (!hist.has_more || pageMin <= maxLoadedIdRef.current + 1) break;
        before = pageMin;
      }
      if (collected.length) {
        setItems((prev) => normalizeHistoryTurns([...prev, ...collected]));
        maxLoadedIdRef.current = newMax;
      }
    } catch {}
  }, [agentId]);

  // Conversation rotation: swap the new conversation's window in place (keep old
  // turns mounted, diff by history_id, no skeleton / scroll jump). Port of softRebind.
  const softRebind = useCallback(
    async (nextCid: string) => {
      const seq = ++requestSeqRef.current;
      try {
        const ids = await api.getHistoryIds(agentId);
        if (seq !== requestSeqRef.current) return;
        const cid = String(ids.conversation_id ?? '') || nextCid;
        const newMax = Number(ids.id ?? 0);
        if (!cid || newMax <= 0) {
          convRef.current = cid;
          setConversationId(cid);
          return;
        }
        const hist = await api.getCurrentHistory(agentId, { limit: WINDOW, conversationId: cid });
        if (seq !== requestSeqRef.current) return;
        const turns = normalizeHistoryTurns(buildTurnsFromRawItems(hist.items ?? []));
        maxLoadedIdRef.current = newMax;
        minLoadedIdRef.current = turns.length ? Number(turns[0].history_id ?? 0) : 0;
        liveTurnIdRef.current = '';
        lastSigRef.current = '';
        setLiveTurn(null);
        setItems(turns);
        setHasMore(!!hist.has_more);
        convRef.current = cid;
        setConversationId(cid);
      } catch {}
    },
    [agentId],
  );


  // ── Typewriter (render-smoothing on top of the single poll source) ────────────
  // The poll updates the FULL target every ~700ms; rendering that directly makes the
  // answer appear in 700ms chunks ("回复文字一顿一顿"). This reveals the trailing TEXT
  // step char-by-char at 60fps toward the target length, so it reads as continuous
  // typing. It is NOT a second data source — it only controls how much of the
  // poll-provided text is shown, so no double-source bugs.
  const liveTargetRef = useRef<HistoryTurn | null>(null);
  const typeRafRef = useRef<number | null>(null);
  const revealRef = useRef<{ key: string; shown: number; frac: number }>({ key: '', shown: 0, frac: 0 });
  const advanceType = useCallback(() => {
    typeRafRef.current = null;
    const target = liveTargetRef.current;
    if (!target) { setLiveTurn(null); return; }
    const steps = (target.steps ?? []) as HistoryStep[];
    const lastIdx = steps.length - 1;
    const last: any = steps[lastIdx];
    const revealing = !!last && last.type === 'text' && typeof last.text === 'string';
    const fullLen = revealing ? (last.text as string).length : 0;
    const key = `${target.history_id}:${steps.length}:${last?.type ?? ''}`;
    const rv = revealRef.current;
    if (rv.key !== key) { rv.key = key; rv.shown = 0; rv.frac = 0; }
    if (!revealing) { setLiveTurn(target); return; } // nothing to type → show as-is
    if (rv.shown < fullLen) {
      // Drain the backlog over ~24 frames (~400ms) so each 700ms chunk finishes about
      // when the next arrives → continuous. Rate scales with backlog (fast catch-up).
      const rate = Math.max(0.5, (fullLen - rv.shown) / 24);
      const acc = rv.frac + rate;
      const stepN = Math.floor(acc);
      rv.shown = Math.min(fullLen, rv.shown + stepN);
      rv.frac = acc - stepN;
    }
    const displayedSteps = steps.slice();
    displayedSteps[lastIdx] = { ...last, text: (last.text as string).slice(0, rv.shown) };
    setLiveTurn({ ...target, steps: displayedSteps });
    if (rv.shown < fullLen) typeRafRef.current = requestAnimationFrame(advanceType);
  }, []);
  const kickType = useCallback(() => {
    if (typeRafRef.current == null) typeRafRef.current = requestAnimationFrame(advanceType);
  }, [advanceType]);

  const clearLiveTurn = useCallback(() => {
    liveTurnIdRef.current = '';
    lastSigRef.current = '';
    liveTargetRef.current = null;
    revealRef.current = { key: '', shown: 0, frac: 0 };
    if (typeRafRef.current != null) { cancelAnimationFrame(typeRafRef.current); typeRafRef.current = null; }
    setLiveTurn(null);
  }, []);

  // ── Part 2: poll reply.json (single source). Attach the in-flight answer as the
  // live tail of q_last (answerId == committedMax + 1); reconcile when a newer turn
  // starts; soft-rebind on conversation rotation. Sets liveTurn DIRECTLY. ─────────
  const pollReply = useCallback(async () => {
    if (!aliveRef.current) return;
    const gen = pollGenRef.current;
    let complete = true;
    const revealOnce = () => {
      if (firstReplyDoneRef.current) return;
      firstReplyDoneRef.current = true;
      if (committedReadyRef.current) setLoading(false);
    };
    // Wait for Part 1 so the tail attaches to a real boundary.
    if (!committedReadyRef.current) {
      if (aliveRef.current && gen === pollGenRef.current) pollTimer.current = setTimeout(pollReply, CURRENT_HISTORY_POLL_WAIT_MS);
      return;
    }
    try {
      const r = await api.getCurrentReply(agentId, convRef.current);
      complete = !!r.complete;
      const cid = String(r.conversation_id ?? '').trim();
      // Agent rotated to a different conversation than committed shows → rebind.
      if (convRef.current && cid && cid !== convRef.current) {
        revealOnce();
        if (!reconcilingRef.current) {
          reconcilingRef.current = true;
          await softRebind(cid);
          reconcilingRef.current = false;
        }
      } else {
        if (cid && !convRef.current) {
          convRef.current = cid;
          setConversationId((p) => p || cid);
        }
        const replyCid = String(r.reply_conversation_id ?? '').trim();
        const answerId = Number(r.history_id ?? 0); // == committedMax + 1
        const replyMaxId = answerId > 0 ? answerId - 1 : 0; // current.json maxID (q_last)
        if (answerId <= 0) {
          if (liveTurnIdRef.current) clearLiveTurn();
        } else {
          // A newer turn committed → pull ONLY the new tail (never below).
          if (replyMaxId > maxLoadedIdRef.current && !reconcilingRef.current) {
            reconcilingRef.current = true;
            await reconcileTail();
            reconcilingRef.current = false;
          }
          const answer = String(r.answer ?? '');
          const thinking = String(r.thinking ?? '');
          const liveItems: any[] = Array.isArray(r.items) ? r.items : [];
          const hasContent = !!(answer || thinking) || liveItems.length > 0;
          const sameConversation = !replyCid || !convRef.current || replyCid === convRef.current;
          // Suppress a reply to a harness/system message ("(silence)") — noise.
          const realQ = replyAnswersRealQuestion(r.question);
          if (sameConversation && realQ && answerId > maxLoadedIdRef.current && (hasContent || !complete)) {
            const turnId = String(r.turn_id ?? '');
            const status = String(r.status ?? 'thinking').trim() || 'thinking';
            const sig = `${turnId}:${answerId}:${status}:${String(r.updated_at ?? '')}:${thinking.length}:${answer.length}:${liveItems.length}`;
            if (sig !== lastSigRef.current) {
              lastSigRef.current = sig;
              liveTurnIdRef.current = turnId;
              // Set the typewriter's TARGET (full text); it reveals char-by-char so
              // the answer reads as continuous typing instead of 700ms chunks.
              if (!complete) onReplyInFlightRef.current?.();
              liveTargetRef.current = {
                history_id: answerId,
                conversation_id: cid || convRef.current,
                role: 'assistant',
                q: '',
                text: '',
                a: answer,
                steps: replyItemsToSteps(liveItems, thinking, answer),
                status: complete ? '' : status,
                model: String(r.model ?? '') || undefined,
              };
              kickType();
            }
          } else if (liveTurnIdRef.current) {
            clearLiveTurn();
          }
        }
      }
      revealOnce();
    } catch {
      revealOnce();
    } finally {
      if (aliveRef.current && gen === pollGenRef.current) {
        pollTimer.current = setTimeout(pollReply, complete ? POLL_IDLE_MS : POLL_ACTIVE_MS);
      }
    }
  }, [agentId, reconcileTail, softRebind, clearLiveTurn, kickType]);

  // Restart the poll immediately (invalidate any in-flight loop) — after a send /
  // resume so the new q + its reply surface without waiting out the idle interval.
  const kickPoll = useCallback(() => {
    pollGenRef.current += 1;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    if (aliveRef.current) pollReply();
  }, [pollReply]);

  // Load an older page of committed turns (prepend, keep scroll position).
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !minLoadedIdRef.current) return;
    setLoadingMore(true);
    preserveScrollOffsetRef.current = true;
    try {
      const hist = await api.getCurrentHistory(agentId, {
        limit: WINDOW,
        before: minLoadedIdRef.current,
        conversationId: convRef.current,
      });
      const older = normalizeHistoryTurns(buildTurnsFromRawItems(hist.items ?? []));
      if (!older.length) {
        setHasMore(false);
      } else {
        minLoadedIdRef.current = Number(older[0].history_id ?? minLoadedIdRef.current);
        setItems((prev) => normalizeHistoryTurns([...older, ...prev]));
        setHasMore(!!hist.has_more);
      }
    } catch {
      // ignore — user can pull again
    } finally {
      setLoadingMore(false);
    }
  }, [agentId, loadingMore, hasMore]);

  // Load-earlier is driven by an IntersectionObserver on a TOP sentinel (port of
  // web): it fires only when the user scrolls the sentinel into view. On a
  // bottom-anchored open the sentinel isn't visible, so nothing auto-loads — this
  // is what prevents "一打开全打开了". loadMore self-guards re-entrancy/no-more.
  const loadMoreFnRef = useRef<() => void>(() => {});
  loadMoreFnRef.current = () => { void loadMore(); };
  const canLoadMore = hasMore && minLoadedIdRef.current > 1;
  useEffect(() => {
    if (!canLoadMore) return;
    const root = domNode();
    if (!root || typeof (globalThis as any).IntersectionObserver !== 'function') return;
    const target = typeof root.querySelector === 'function' ? root.querySelector('[data-load-more]') : null;
    if (!target) return;
    const io = new (globalThis as any).IntersectionObserver(
      (entries: any[]) => { if (entries.some((e) => e.isIntersecting)) loadMoreFnRef.current(); },
      { root, threshold: 0.1 },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [canLoadMore, items, domNode]);

  // Open / re-focus: reset, load committed, then poll the reply tail.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      aliveRef.current = true;
      focusedRef.current = true;
      // Instant paint from cache (memory→persistent, sync) so reopening an agent
      // shows the last-seen conversation immediately; loadWindow() below still
      // refetches fresh and reconciles. Cache miss → fall back to the spinner.
      const cached = historyCache.get(agentId);
      if (cached && cached.turns.length) {
        convRef.current = cached.conversationId;
        setConversationId(cached.conversationId);
        maxLoadedIdRef.current = cached.maxId;
        minLoadedIdRef.current = cached.minId;
        setItems(cached.turns);
        setHasMore(cached.hasMore);
        setLoading(false);
      } else {
        setItems([]);
        setLoading(true);
      }
      setLiveTurn(null);
      lastSigRef.current = '';
      liveTurnIdRef.current = '';
      liveTargetRef.current = null;
      revealRef.current = { key: '', shown: 0, frac: 0 };
      if (typeRafRef.current != null) { cancelAnimationFrame(typeRafRef.current); typeRafRef.current = null; }
      // On a cache hit the committed window is already painted, so the poll loop
      // may attach the live tail immediately; on a miss it waits for loadWindow.
      committedReadyRef.current = !!(cached && cached.turns.length);
      firstReplyDoneRef.current = false;
      didInitialScrollRef.current = false;
      shouldStickBottomRef.current = true;
      preserveScrollOffsetRef.current = false;
      activeSpacerTurnKeyRef.current = '';
      anchoredQKeyRef.current = '';
      replySeenActiveRef.current = false;
      applyAnchorSpacerHeight(0);
      (async () => {
        try {
          await loadWindow();
          if (mounted) setError(null);
        } catch (e: any) {
          if (mounted) setError(String(e?.message ?? e));
        } finally {
          committedReadyRef.current = true;
          if (mounted && firstReplyDoneRef.current) setLoading(false);
        }
        if (!mounted || !aliveRef.current) return;
        pollReply();
      })();
      return () => {
        mounted = false;
        aliveRef.current = false;
        focusedRef.current = false;
        if (pollTimer.current) clearTimeout(pollTimer.current);
        pollTimer.current = null;
        clearScheduledScrolls();
      };
    }, [agentId, loadWindow, pollReply, applyAnchorSpacerHeight, clearScheduledScrolls]),
  );

  // Pause polling in the background; resume on return — but ONLY when this
  // screen is still the focused one. Without the focus gate, a blurred screen
  // left mounted under the nav stack would restart its poll loop on every
  // app foreground and keep polling forever behind the visible screen.
  useEffect(() => {
    const onChange = (s: AppStateStatus) => {
      if (s === 'active') {
        if (focusedRef.current && !aliveRef.current) {
          aliveRef.current = true;
          pollReply();
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

  // A new send: nudge the poll so the committed q + its reply surface fast. Like
  // web, there is NO optimistic bubble — the q renders once it lands in committed
  // (the anchor then pins it to the top). (~one poll round-trip, sub-second.)
  // Optimistic double placeholder (port of web's OPTIMISTIC_Q): the instant a
  // send happens, paint the q bubble + reserve the answer slot BEFORE the poll
  // round-trips — the q must never lag the keypress. Cleared when a NEWER
  // committed user turn lands (the real q) or on a 60s no-show timeout.
  const [optimistic, setOptimistic] = useState<{ text: string; nonce: number; baselineId: number } | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (pending.nonce === lastNonceRef.current) return;
    lastNonceRef.current = pending.nonce;
    setOptimistic({ text: pending.text, nonce: pending.nonce, baselineId: maxLoadedIdRef.current });
    kickPoll();
  }, [pending, kickPoll]);
  // `pending: null` from the send path = the send FAILED → drop the bubble.
  useEffect(() => {
    if (pending === null) setOptimistic(null);
  }, [pending]);
  useEffect(() => {
    if (!optimistic) return;
    const timer = setTimeout(() => {
      setOptimistic((cur) => (cur && cur.nonce === optimistic.nonce ? null : cur));
    }, 60000);
    return () => clearTimeout(timer);
  }, [optimistic]);

  // ── Render data: web's displayItems (no merge, no optimistic) ────────────────
  const committedMaxId = useMemo(
    () => items.reduce((m, t) => Math.max(m, Number(t?.history_id ?? 0)), 0),
    [items],
  );
  // The real committed q landed → retire the optimistic bubble in place.
  useEffect(() => {
    if (!optimistic) return;
    const landed = items.some(
      (t) =>
        t?.role === 'user' &&
        Number(t?.history_id ?? 0) > optimistic.baselineId &&
        stripHarnessNoise(String(t.q ?? t.text ?? '')) === optimistic.text.trim(),
    );
    const anyNewerUser = items.some(
      (t) => t?.role === 'user' && Number(t?.history_id ?? 0) > optimistic.baselineId,
    );
    if (landed || anyNewerUser) setOptimistic(null);
  }, [items, optimistic]);
  // While the live turn renders the in-flight assistant response (with its tool
  // steps, in serial order), HIDE the committed assistant turn(s) of that SAME
  // turn — else round-0's tools render BOTH committed (above) and in the live turn
  // (below) = the "reply 先到上一条 再乱跳" duplicate/jump. The live turn owns the
  // full ordered render until the turn completes and migrates into committed.
  // Boolean, not the liveTurn object: the typewriter replaces liveTurn ~60×/s
  // while it types, and an object dep would recompute displayItems (new array
  // identity) — and re-fire everything downstream of it — every frame.
  const liveVisible = !!liveTurn && Number(liveTurn.history_id ?? 0) > committedMaxId;
  const displayItems = useMemo(() => {
    // Display layer drops system noise entirely (用户指令:agent 显示层完全过滤
    // system message):role==='system' turns and harness-only user turns (a q
    // that is nothing but system-reminder/recap blocks) never render. Their
    // assistant recap responses are dropped separately via recapResponses.
    const visible = items.filter((t) => {
      if (t?.role === 'system') return false;
      if (t?.role === 'user') {
        const q = String((t as any)?.q ?? (t as any)?.text ?? '');
        // Drop the turn when nothing real remains after removing ALL system noise
        // (leading + embedded + trailing), not just leading blocks.
        if (q.trim() && !stripHarnessNoise(q)) return false;
      }
      return true;
    });
    if (!liveVisible) return visible;
    let lastUserId = 0;
    for (const t of visible) if (t?.role === 'user') lastUserId = Math.max(lastUserId, Number(t?.history_id ?? 0));
    return visible.filter((t) => !(t?.role === 'assistant' && Number(t?.history_id ?? 0) > lastUserId));
  }, [items, liveVisible]);

  // Recap-on-return is system noise: a harness-only user turn + the assistant
  // recap it triggers. The harness q itself is dropped by displayItems, so this
  // must scan the UNFILTERED items — scanning displayItems can never see the
  // harness q, pendingRecap never sets, and the recap answer leaks through as an
  // orphan assistant turn with no question above it. The drop Set holds object
  // identities from `items`, which displayItems shares (it's a filter of items).
  const recapResponses = useMemo(() => {
    const drop = new Set<HistoryTurn>();
    let pendingRecap = false;
    for (const t of items) {
      if (t?.role === 'system') continue; // may sit between the harness q and its recap
      const q = String((t as any)?.text || (t as any)?.q || '');
      if (t?.role === 'user' && q.trim()) {
        const { blocks } = splitLeadingHarnessBlocks(q);
        pendingRecap = !stripHarnessNoise(q) && blocks.length > 0;
        continue;
      }
      const hasContent =
        String((t as any)?.a || '').trim().length > 0 ||
        (Array.isArray((t as any)?.steps) && (t as any).steps.length > 0);
      if (t?.role === 'assistant' && pendingRecap && hasContent) {
        pendingRecap = false;
        drop.add(t);
      }
    }
    return drop;
  }, [items]);

  // Coarse live signature for the anchor effect: changes on poll-level transitions
  // (new turn / status flip / a step appended), NOT on every typewriter frame.
  // Depending on the liveTurn OBJECT re-ran the anchor effect ~60×/s during the
  // char-by-char reveal — a rAF + getBoundingClientRect layout read per frame.
  // The per-token pin hold lives in onContentSizeChange, which doesn't need this.
  const liveSig = liveTurn
    ? `${liveTurn.history_id ?? ''}:${liveTurn.status ?? ''}:${(liveTurn.steps ?? []).length}`
    : '';
  const liveVisibleRef = useRef(false);
  liveVisibleRef.current = liveVisible;

  // ── Anchor: pin a new q to the viewport top, reply streams below (port of web's
  // CurrentHistoryView §"new q to top", incl. the smooth-scroll + hand-off + the
  // "don't shrink spacer before streaming" 回落 guard). ───────────────────────────
  const computeLastUserKey = useCallback((): string => {
    // The optimistic bubble IS the newest question while it's up — anchor it.
    if (optimistic) return `opt-${optimistic.nonce}`;
    for (let i = displayItems.length - 1; i >= 0; i -= 1) {
      const t = displayItems[i];
      if (t?.role === 'user' && !!stripHarnessNoise(String(t.q ?? t.text ?? ''))) {
        return String(t.history_id ?? `u-${i}`);
      }
    }
    return '';
  }, [displayItems, optimistic]);

  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y;
      shouldStickBottomRef.current = contentSize.height - y - layoutMeasurement.height <= 80;
      // load-earlier is NOT triggered here. Auto-loading on every scroll near the top
      // fired on open and paged in the WHOLE history ("一打开全打开了"). Like web, it's
      // an IntersectionObserver on a top sentinel that only fires when scrolled into view.
    },
    [],
  );

  // w-10064's RN tip: re-assert the anchor on content-size change (markdown/code
  // reflow shifts offsetTop) — more reliable than timers alone. Keeps the in-flight
  // q pinned to the top as its reply grows below it; else follows the bottom if stuck.
  const onContentSizeChange = useCallback(() => {
    const node = domNode();
    if (!node) {
      // Native (iOS/Android): no DOM, so the web scrollTop helpers all no-op and
      // the list would otherwise open pinned to the TOP. The top-anchor mechanism
      // is web-only; on native we just want chat behaviour — land at the newest
      // turn on open, then keep following the bottom while the user is parked
      // there (onScroll maintains shouldStickBottomRef). Imperative scrollToEnd
      // is the native equivalent of web's scheduleBottom.
      if (!didInitialScrollRef.current || shouldStickBottomRef.current) {
        // While the live tail is typing, content grows every frame — an ANIMATED
        // scrollToEnd would be restarted 60×/s and stutter. Jump-follow instead;
        // keep the animation for discrete changes (a new committed turn landing).
        const animated = didInitialScrollRef.current && !liveVisibleRef.current;
        scrollRef.current?.scrollToEnd({ animated });
        didInitialScrollRef.current = true;
      }
      return;
    }
    if (activeSpacerTurnKeyRef.current) {
      // IDEMPOTENT hold: only re-pin if q actually drifted (>6px). An unconditional
      // pin every token snapped the view = "滚动跟随生硬". A stable q → no-op → smooth.
      const qTop = turnTopInContent(node, activeSpacerTurnKeyRef.current);
      if (qTop != null && Math.abs(qTop - 8) > 6) node.scrollTop = node.scrollTop + (qTop - 8);
    } else if (shouldStickBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [domNode]);

  useEffect(() => {
    if (!liveVisible && loading) return;
    const frame = requestAnimationFrame(() => {
      const node = domNode();
      if (!node) return;

      // loadMore prepend → keep the user's position, don't anchor.
      if (preserveScrollOffsetRef.current) {
        preserveScrollOffsetRef.current = false;
        didInitialScrollRef.current = true;
        return;
      }

      const lastUserKey = computeLastUserKey();

      // First load: show the newest turn (bottom), mark it anchored.
      if (!didInitialScrollRef.current) {
        anchoredQKeyRef.current = lastUserKey;
        applyAnchorSpacerHeight(0);
        runScheduledScroll(scheduleBottom(node));
        shouldStickBottomRef.current = true;
        didInitialScrollRef.current = true;
        return;
      }

      // A NEW question appeared → pin it to the TOP + open the bottom spacer. Use an
      // INSTANT pin (scheduleTurnTop = pinTurnTop now + rAF + retry timers), NOT a
      // smooth scrollTo: RN-Web's ScrollView doesn't honor a programmatic smooth
      // scrollTo reliably (it drifted to 0 → top sentinel showed → loadMore looped →
      // the list exploded). Instant pin lands q at a large scrollTop, so the sentinel
      // never shows. The spacer is set imperatively first so there's room to reach top.
      if (lastUserKey && lastUserKey !== anchoredQKeyRef.current) {
        const target = findTurnEl(node, lastUserKey);
        if (target) {
          anchoredQKeyRef.current = lastUserKey;
          activeSpacerTurnKeyRef.current = lastUserKey;
          replySeenActiveRef.current = false;
          const spacerH = Math.max(0, node.clientHeight - target.offsetHeight - 16);
          const spacerEl = typeof node.querySelector === 'function' ? node.querySelector('[data-anchor-spacer]') : null;
          if (spacerEl && spacerEl.style) spacerEl.style.height = `${spacerH}px`; // sync → room to pin
          applyAnchorSpacerHeight(spacerH);
          // GLIDE q to the top (custom smooth — RN-Web ignores native smooth scrollTo).
          const tgt = node.scrollTop + (target.getBoundingClientRect().top - node.getBoundingClientRect().top) - 8;
          animateScrollTop(node, tgt, 320);
          shouldStickBottomRef.current = false;
          return;
        }
      }

      // A q with its reply settling. While the reply is IN FLIGHT do nothing — the q
      // stays at the top because the reply grows BELOW it (scrollTop unchanged); any
      // reflow is re-pinned idempotently by onContentSizeChange. Resizing the spacer
      // per frame is what made it jitter ("一直在跳").
      if (activeSpacerTurnKeyRef.current) {
        const key = activeSpacerTurnKeyRef.current;
        const qTop = turnTopInContent(node, key);
        if (qTop == null) {
          activeSpacerTurnKeyRef.current = '';
          return;
        }
        const lastCommitted = displayItems[displayItems.length - 1];
        const replyInFlight = !!liveSig || isActiveAssistantStatus(String(lastCommitted?.status ?? ''));
        if (replyInFlight) {
          replySeenActiveRef.current = true;
          // Keep q at the top as the reply grows below it. IDEMPOTENT: only correct if
          // it actually drifted (>6px), and GLIDE the correction (not a hard snap) so
          // streaming following reads smooth. Runs per poll (~700ms), so no jitter.
          if (Math.abs(qTop - 8) > 6) animateScrollTop(node, node.scrollTop + (qTop - 8), 220);
          return;
        }
        if (!replySeenActiveRef.current) return; // first-token gap: don't shrink → no 回落
        // Reply settled: shrink the spacer once to remove blank below, then release.
        const belowQ = node.scrollHeight - anchorSpacerHeightRef.current - qTop;
        const measured = Math.max(0, node.clientHeight - belowQ - 16);
        applyAnchorSpacerHeight(measured);
        if (measured <= 0) activeSpacerTurnKeyRef.current = '';
        return;
      }
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, displayItems, liveSig, liveVisible, optimistic]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }
  // Only take over the screen with an error when there's nothing to show. If a
  // cached/loaded conversation is on screen, a failed background refresh must not
  // blank it.
  if (error && displayItems.length === 0 && !liveVisible) {
    return (
      <View style={styles.center}>
        <Text variant="callout" tone="danger" style={{ textAlign: 'center' }}>
          {error}
        </Text>
      </View>
    );
  }

  const isEmpty = displayItems.length === 0 && !liveVisible;
  return (
    // Single non-virtualized scroll container (windowed to WINDOW committed items).
    // On web this is one overflow <div> — required for the top-anchor mechanism
    // (precise scrollTop + a dynamic bottom spacer), exactly like cicy-code.
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={styles.list}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onContentSizeChange={onContentSizeChange}
    >
      {/* Load-earlier at the TOP. When more exists, a sentinel (data-load-more) the
          IntersectionObserver watches — only fires when scrolled into view (also
          tappable). Not auto-fired on open → no "一打开全打开了". */}
      {isEmpty ? null : loadingMore ? (
        <View style={styles.loadMoreRow}>
          <ActivityIndicator size="small" color={theme.textMuted} />
        </View>
      ) : canLoadMore ? (
        <View {...({ dataSet: { loadMore: '1' } } as any)} style={styles.loadMoreRow}>
          <PressableScale onPress={() => { void loadMore(); }} hitSlop={6}>
            <Text variant="caption" tone="faint">
              {i18n.t('chat.loadEarlier')}
            </Text>
          </PressableScale>
        </View>
      ) : (
        <View style={styles.loadMoreRow}>
          <Text variant="caption" tone="faint">
            {i18n.t('chat.beginningOfHistory')}
          </Text>
        </View>
      )}

      {isEmpty ? (
        <View style={styles.center}>
          <Text tone="muted" variant="h3" style={{ marginBottom: spacing.sm }}>
            {i18n.t('chat.noTurnsTitle')}
          </Text>
          <Text tone="faint" variant="callout" style={{ textAlign: 'center' }}>
            {i18n.t('chat.noTurnsBody')}
          </Text>
        </View>
      ) : null}

      {/* Part 1 — committed turns. Each carries data-turn-key so the anchor can find
          a q. Recap responses dropped. In-flight assistants suppressed (displayItems). */}
      {displayItems.map((t, i) => {
        if (recapResponses.has(t)) return null;
        const turnKey = String(t.history_id ?? `u-${i}`);
        return (
          <View key={`row-${t.history_id ?? t.turn_id ?? i}`} {...({ dataSet: { turnKey } } as any)}>
            <Turn turn={t} isLast={!liveVisible && i === displayItems.length - 1} />
          </View>
        );
      })}

      {/* Optimistic q + reserved answer slot — painted the same frame as the
          send, replaced in place when the real committed q + live tail arrive. */}
      {optimistic ? (
        <View key={`opt-${optimistic.nonce}`} {...({ dataSet: { turnKey: `opt-${optimistic.nonce}` } } as any)} style={{ gap: spacing.md }}>
          <QuestionBubble text={optimistic.text} />
          {!liveVisible ? (
            <View>
              <TypingDots />
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Part 2 — the live tail (answer-only) right after committed, rendered
          SEPARATELY so its per-token growth never re-renders committed. */}
      {liveVisible && liveTurn ? (
        <View key="live" {...({ dataSet: { turnKey: 'live' } } as any)}>
          <Turn turn={liveTurn} isLast />
        </View>
      ) : null}

      {/* Dynamic bottom spacer: room so a short q+reply can sit at the top; sized
          once when the q appears, shrunk once after the reply settles. */}
      <View {...({ dataSet: { anchorSpacer: '1' } } as any)} style={{ height: anchorSpacerHeight }} />
    </ScrollView>
  );
}

// User question bubble = web's CollapsibleQ, minus the system fold: leading
// harness blocks (system-reminder / recap / continuation / command echoes) are
// DROPPED — only the real question renders.
function QuestionBubble({ text }: { text: string }) {
  const theme = useTheme();
  // Harness/system blocks (system-reminder / task-notification / recap /
  // continuation) are stripped wherever they appear — leading, embedded, or
  // trailing — so the display layer never shows system content.
  const remaining = useMemo(() => stripHarnessNoise(text), [text]);
  if (!remaining) return null;
  return (
    <View style={{ gap: spacing.sm }}>
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
  // System/developer notices never render — display layer filters them fully.
  if (turn.role === 'system') return null;
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

// memo'd by CONTENT: every poll rebuilds the steps array with fresh objects, so a
// plain re-render would repaint the WHOLE reply each 700ms ("每次刷新整段闪"). With
// this comparator only the step whose text/tools actually changed (the growing last
// one) repaints; all earlier steps are skipped.
const Step = memo(
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
  },
  (a, b) => {
    if (a.streaming !== b.streaming) return false;
    const s1 = a.step as any;
    const s2 = b.step as any;
    if (s1.type !== s2.type) return false;
    if (s1.type === 'thinking' || s1.type === 'text') return s1.text === s2.text;
    if (s1.type === 'tool') return JSON.stringify(s1.tools) === JSON.stringify(s2.tools);
    return false;
  },
);

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
          {i18n.t('chat.thinkingLabel')}
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
    // Standalone media reference on its own line:
    //   ![name](url)      → inline image thumbnail (tap → full)
    //   [🎬 name](url)     → video card (tap → system player)
    //   [name](/assets/…)  → file card (tap → open)
    const media = /^\s*(!?)\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (media) {
      const isImage = media[1] === '!';
      const label = media[2].replace(/^🎬\s*/, '');
      const url = media[3];
      const looksAsset = /\/assets\/files\//.test(url) || /^https?:/.test(url) || url.startsWith('/');
      const isVideo = /\.(mp4|mov|m4v|webm|3gp|mkv)(\?|$)/i.test(url) || media[2].startsWith('🎬');
      if (looksAsset && (isImage || isVideo || /\/assets\/files\//.test(url))) {
        flushPara();
        const k2 = blocks.length + 1;
        blocks.push(
          <MediaBlock key={`m${k2}`} url={url} name={label} isImage={isImage && !isVideo} isVideo={isVideo} theme={theme} />,
        );
        continue;
      }
    }
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

// Rendered attachment: image → inline thumbnail (tap opens full), video → an
// inline player (expo-video), file → a card that opens in the system viewer.
// assetUri() resolves the /assets/files path to an absolute URL + the Bearer
// header cloud needs to serve it.
function MediaBlock({
  url, name, isImage, isVideo, theme,
}: { url: string; name: string; isImage: boolean; isVideo: boolean; theme: ReturnType<typeof useTheme> }) {
  const src = useMemo(() => assetUri(url), [url]);
  const open = () => Linking.openURL(src.uri).catch(() => {});

  if (isImage) {
    return (
      <PressableScale onPress={open} scaleTo={0.98} style={styles.mediaImageWrap}>
        <Image source={src as any} style={styles.mediaImage} resizeMode="cover" />
      </PressableScale>
    );
  }
  if (isVideo) {
    return (
      <View style={styles.mediaVideoWrap}>
        <InlineVideo uri={src.uri} headers={src.headers} />
      </View>
    );
  }
  return (
    <PressableScale
      onPress={open}
      scaleTo={0.98}
      style={[styles.mediaCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      <View style={[styles.mediaIcon, { backgroundColor: theme.surfaceMuted }]}>
        <Ionicons name={isVideo ? 'play' : 'document-outline'} size={18} color={theme.text} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="callout" numberOfLines={1}>{name || (isVideo ? 'video' : 'file')}</Text>
        <Text variant="caption" tone="faint">{isVideo ? i18n.t('chat.tapToPlay') : i18n.t('chat.tapToOpen')}</Text>
      </View>
    </PressableScale>
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
  mediaImageWrap: {
    borderRadius: radius.md,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginVertical: 2,
  },
  mediaImage: {
    width: 200,
    height: 200,
    maxWidth: '100%',
    backgroundColor: '#000',
  },
  mediaVideoWrap: {
    alignSelf: 'flex-start',
    marginVertical: 2,
  },
  mediaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.sm,
    maxWidth: 260,
    marginVertical: 2,
  },
  mediaIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
