// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// ONE-TO-ONE port of cicy-code app/src/components/chat/history/useCurrentHistory.ts.
// The orchestration (committed window + polled live tail + WS acceleration) is
// copied function-for-function from the web reference; only the runtime deps are
// swapped for React-Native equivalents (see the header comment on each block):
//   • window event bridge          → opts callbacks (onReplyInFlight/onReplyDone)
//                                     + the `pending` prop drives onNudge/cancel.
//   • window.dispatchEvent(busy)   → emitBusy → onReplyInFlight()/onReplyDone().
//   • cicy:agent-stream-delta      → ChatWsClient on() feeds onStreamDelta directly.
//   • document.visibilitychange    → AppState 'active'.
//   • loadWindowItems + IndexedDB  → api.getCurrentHistory (single ranged fetch,
//                                     no positional-id cache — RN memory-only).
//   • DOM scrollTop/scrollHeight   → returned refs; the render layer (ScrollView)
//                                     owns the actual scroll (data layer decoupled).
//
// The invariants in the web file's docs §9 are preserved verbatim (see the inline
// notes at each guard). current-reply is EVENT-DRIVEN for cicy AND non-cicy —
// same single path, no agent-type fork: opening a chat runs one full snapshot
// pass (committed window + reply.json live tail = the most complete record at
// that moment); while a reply is in flight the pass follows at ACTIVE cadence
// and stops on complete; WS events / sends / app-resume each trigger one more
// pass. An idle open chat makes zero requests.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { api, createApi, type Endpoint } from '@/src/api/http';
import { ChatWsClient } from '@/src/api/chatws';

// The endpoint-bound API surface (team singleton or a Hub agent's createApi).
type ApiClient = ReturnType<typeof createApi>;
import type { CurrentReplyResp, HistoryStep, HistoryTurn, RawHistoryItem } from '@/src/api/types';
import {
  buildTurnsFromRawItems,
  normalizeHistoryTurns,
  replyItemsToSteps,
  splitLeadingHarnessBlocks,
  cicyCompactSummaryOf,
  stripHarnessNoise,
} from '@/src/lib/historyParse';
import { historyCache } from '@/src/lib/historyCache';
import { useAuthStore } from '@/src/store/auth';

// ── constants (照搬 constants.ts 的数值) ─────────────────────────────────────
const CURRENT_HISTORY_WINDOW = 16;
const CURRENT_HISTORY_POLL_ACTIVE_MS = 500;
const CURRENT_HISTORY_POLL_IDLE_MS = 2500;
const CURRENT_HISTORY_POLL_WAIT_MS = 150;
const OPTIMISTIC_Q_TIMEOUT_MS = 60000;

// Content size of a live turn's steps — the poll's regress guard uses it to tell
// whether a poll snapshot is BEHIND the (WS-ahead) tail we already show.
// (verbatim from web lib/misc.ts liveStepsContentSize.)
function liveStepsContentSize(steps: HistoryTurn['steps']): { textLen: number; toolCount: number } {
  let textLen = 0;
  let toolCount = 0;
  for (const s of (steps || []) as any[]) {
    if (s?.type === 'text' || s?.type === 'thinking') textLen += String(s?.text || '').length;
    else if (s?.type === 'tool') toolCount += Array.isArray(s?.tools) ? s.tools.length : 0;
  }
  return { textLen, toolCount };
}

// A reply that answers a harness-only question (recap-on-return, suggestion
// mode) is system noise — never attach it as the visible live tail, even when
// it sits completed in reply.json (e.g. w-10122 #528: an uncommitted recap
// parked as the "current reply" would otherwise render as the last answer).
// Mobile display policy, matching recapResponses' committed-side drop; web has
// no such gate. Detected via the reply's `question` field (carried by
// reply.json / current-reply). Empty/absent question → unknown → treat as real
// (don't over-suppress).
function replyAnswersRealQuestion(question?: string): boolean {
  const s = String(question ?? '').trim();
  if (!s) return true;
  if (/^\[\s*suggestion mode/i.test(s)) return false;
  return !!splitLeadingHarnessBlocks(s).remaining.trim();
}

// getHistoryIDs — RN equivalent of web lib/dataAccess.getHistoryIDs.
// `a` is the endpoint-bound API (team singleton, or a Hub agent's createApi).
async function getHistoryIDs(a: ApiClient, paneId: string): Promise<any> {
  return a.getHistoryIds(paneId);
}

// loadWindowItems — RN port of web lib/dataAccess.loadWindowItems, minus the
// IndexedDB layer (positional history_ids drift, so RN never persists a turn
// cache): one contiguous ranged fetch [lo..hi], returned strictly ascending, with
// the window low bound `lo` so the caller derives hasMore/nextBefore exactly like
// web. `fresh` is accepted for signature parity (there is no cache to bypass).
async function loadWindowItems(
  a: ApiClient,
  paneId: string,
  conversationId: string,
  hi: number,
  size = CURRENT_HISTORY_WINDOW,
  _opts: { fresh?: boolean } = {},
): Promise<{ items: RawHistoryItem[]; lo: number }> {
  if (hi <= 0 || !conversationId) return { items: [], lo: 0 };
  const lo = Math.max(1, hi - Math.max(1, size) + 1);
  const data = await a.getCurrentHistory(paneId, {
    before: hi + 1,
    limit: hi - lo + 1,
    conversationId,
  });
  const fetched = Array.isArray(data?.items) ? data.items : [];
  const items = fetched
    .filter((it: any) => {
      const id = Number(it?.history_id ?? it?.id ?? 0);
      return id >= lo && id <= hi;
    })
    .sort((a: any, b: any) => Number(a?.history_id ?? a?.id ?? 0) - Number(b?.history_id ?? b?.id ?? 0));
  return { items, lo };
}

export type UseCurrentHistoryOpts = {
  paneId: string;
  open: boolean;
  promptsOnly: boolean;
  hideTools: boolean;
  agentType: string;
  consumeWsDeltas: boolean;
  // RN bridge (replaces window events):
  // - `pending`: a q the composer just sent → drives onNudge (null = send failed
  //   → onCancelOptimistic). nonce changes per send so the same text can resend.
  pending?: { text: string; nonce: number } | null;
  // - busy signal to the composer (replaces window 'cicy:dispatcher-busy').
  onReplyInFlight?: () => void;
  onReplyDone?: () => void;
  // - endpoint override: when set, the whole two-part engine (history/reply
  //   fetches + chat WS) targets this server+token instead of the active team.
  //   A Hub agent passes its reach_url + node api_token here so the SAME chat
  //   serves hub agents. Omit → active team in the store.
  endpoint?: Endpoint | null;
};

// Normalized WS delta detail (built by the WS client callback, consumed by
// onStreamDelta — the RN stand-in for the cicy:agent-stream-delta CustomEvent).
type StreamDeltaDetail = {
  agent_id?: string;
  turn_id?: string;
  delta?: string;
  kind?: 'text' | 'thinking' | '';
  status?: string;
};

export function useCurrentHistory(opts: UseCurrentHistoryOpts) {
  const { paneId, open, promptsOnly, consumeWsDeltas } = opts;
  // Endpoint-bound API: a Hub agent's reach_url+token, or the active team.
  // Memoized on the endpoint identity so poll loops keep a stable client.
  const endpoint = opts.endpoint ?? null;
  const apiClient = useMemo<ApiClient>(
    () => (endpoint ? createApi(endpoint) : api),
    [endpoint?.serverUrl, endpoint?.token],
  );
  const apiRef = useRef(apiClient);
  apiRef.current = apiClient;
  const onReplyInFlightRef = useRef(opts.onReplyInFlight);
  onReplyInFlightRef.current = opts.onReplyInFlight;
  const onReplyDoneRef = useRef(opts.onReplyDone);
  onReplyDoneRef.current = opts.onReplyDone;

  const [items, setItems] = useState<HistoryTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [conversationId, setConversationId] = useState('');
  const [model, setModel] = useState('');
  const [promptList, setPromptList] = useState<{ id: number; ts: string; content: string }[]>([]);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [liveTurn, setLiveTurn] = useState<HistoryTurn | null>(null);
  const liveTurnRef = useRef<HistoryTurn | null>(null);
  const liveTurnIdRef = useRef('');
  const maxLoadedIdRef = useRef(0);
  const committedReadyRef = useRef(false);
  const firstReplyDoneRef = useRef(false);
  const shouldStickBottomRef = useRef(true);
  const requestSeqRef = useRef(0);
  const [optimisticQ, setOptimisticQ] = useState<{ text: string; ts: number } | null>(null);
  const optimisticBaselineUserIdRef = useRef(0);
  const [compacting, setCompacting] = useState(false);
  const compactingTsRef = useRef(0);
  const compactingRef = useRef(false);
  useEffect(() => { compactingRef.current = compacting; }, [compacting]);
  const clearedConvIdRef = useRef('');
  const conversationIdRef = useRef('');
  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => {
    if (!compacting) return;
    const last = items[items.length - 1] as any;
    if (last && cicyCompactSummaryOf(last.text || last.q) !== null) { setCompacting(false); return; }
    const remaining = Math.max(1000, 100000 - (Date.now() - compactingTsRef.current));
    const t = setTimeout(() => setCompacting(false), remaining);
    return () => clearTimeout(t);
  }, [compacting, items]);

  const optimisticActiveRef = useRef(false);
  const replyInFlightRef = useRef(false);
  const lastBusyEmitRef = useRef<boolean | null>(null);
  // Broadcast "still waiting for a reply". busy = optimistic q up OR poll saw an
  // in-flight reply. Only emit on change. (window 'cicy:dispatcher-busy' → the
  // composer's onReplyInFlight/onReplyDone callbacks.)
  const emitBusy = (busy: boolean) => {
    if (lastBusyEmitRef.current === busy) return;
    lastBusyEmitRef.current = busy;
    if (busy) onReplyInFlightRef.current?.();
    else onReplyDoneRef.current?.();
  };
  const itemsRef = useRef<HistoryTurn[]>([]);

  const clearLiveTurn = () => {
    liveTurnRef.current = null;
    liveTurnIdRef.current = '';
    setLiveTurn(null);
  };

  // Fetch everything current.json now holds beyond our committed boundary — ONLY
  // the new tail (committedMaxId, newMax]. Returns the built turns WITHOUT
  // touching state; the poll commits items + live tail in ONE synchronous batch.
  const fetchTailBeyondBoundary = async (): Promise<{ tail: HistoryTurn[]; newMax: number } | null> => {
    try {
      const ids = await getHistoryIDs(apiRef.current, paneId);
      const cid = String(ids?.conversation_id || '').trim();
      const newMax = Number(ids?.id || 0);
      if (!cid || newMax <= maxLoadedIdRef.current) return null;
      if (clearedConvIdRef.current && cid === clearedConvIdRef.current) return null;
      const size = Math.min(newMax - maxLoadedIdRef.current, 100);
      const { items: raw } = await loadWindowItems(apiRef.current, paneId, cid, newMax, size, { fresh: true });
      const tail = buildTurnsFromRawItems(raw);
      if (!tail.length) return null;
      return { tail, newMax };
    } catch {
      return null;
    }
  };

  // Seamless conversation rotation: swap the new conversation's window IN PLACE
  // (diff by history_id, no skeleton / scroll jump). conversationId is NOT a
  // dependency of the reset/open effects, so updating it here only re-subscribes
  // the poll — it does not reload.
  const softRebind = async (nextCid: string) => {
    const seq = ++requestSeqRef.current;
    try {
      const ids = await getHistoryIDs(apiRef.current, paneId);
      if (seq !== requestSeqRef.current) return;
      const cid = String(ids?.conversation_id || '').trim() || nextCid;
      const newMax = Number(ids?.id || 0);
      if (clearedConvIdRef.current && cid === clearedConvIdRef.current) return;
      if (!cid || newMax <= 0) {
        maxLoadedIdRef.current = 0;
        clearLiveTurn();
        setItems([]);
        setHasMore(false);
        setNextBefore(null);
        setConversationId(cid);
        return;
      }
      const { items: raw, lo } = await loadWindowItems(apiRef.current, paneId, cid, newMax, CURRENT_HISTORY_WINDOW, { fresh: true });
      if (seq !== requestSeqRef.current) return;
      const turns = buildTurnsFromRawItems(raw);
      maxLoadedIdRef.current = newMax;
      setHasMore(lo > 1);
      setNextBefore(lo);
      setModel(String(ids?.model || '').trim());
      clearLiveTurn();
      setItems(turns);
      setConversationId(cid);
    } catch {}
  };

  // reset on paneId/open change (web lines 213-231; DOM/scroll bits dropped).
  useEffect(() => {
    shouldStickBottomRef.current = true;
    maxLoadedIdRef.current = 0;
    committedReadyRef.current = false;
    firstReplyDoneRef.current = false;
    setHasMore(false);
    setNextBefore(null);
    setConversationId('');
    setModel('');
    clearLiveTurn();
    setOptimisticQ(null);
    optimisticBaselineUserIdRef.current = 0;
    replyInFlightRef.current = false;
    setCompacting(false);
    clearedConvIdRef.current = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, open]);

  // ── Part 1: committed window. Instant paint from the RN memory/persistent
  // cache (historyCache — the analog of web's window._cacheHistory), then a fresh
  // fetch overwrites it. The cache is never trusted as truth. ──────────────────
  useEffect(() => {
    if (!open || !paneId) return;
    let cancelled = false;
    const requestSeq = ++requestSeqRef.current;
    shouldStickBottomRef.current = true;
    const snap = historyCache.get(paneId);
    const hasSnap = !!(snap && snap.turns.length);
    if (hasSnap && snap) {
      setItems(snap.turns);
      setConversationId(snap.conversationId);
      setHasMore(snap.hasMore);
      setNextBefore(snap.minId || null);
      maxLoadedIdRef.current = snap.maxId;
    }
    if (!hasSnap) setLoading(true);
    getHistoryIDs(apiRef.current, paneId)
      .then(async (data: any) => {
        if (cancelled || requestSeq !== requestSeqRef.current) return [] as HistoryTurn[];
        const nextConversationId = String(data?.conversation_id || '').trim();
        const nextMaxHistoryId = Number(data?.id || 0);
        setConversationId(nextConversationId);
        if (hasSnap && snap && snap.conversationId && snap.conversationId !== nextConversationId) {
          clearLiveTurn();
          setOptimisticQ(null);
          optimisticBaselineUserIdRef.current = 0;
        }
        setModel(String(data?.model || '').trim());
        setPromptList(Array.isArray(data?.prompts) ? data.prompts : []);
        if (!nextConversationId || nextMaxHistoryId <= 0) {
          setHasMore(false);
          setNextBefore(null);
          return [] as HistoryTurn[];
        }
        const { items: rawItems, lo } = await loadWindowItems(
          apiRef.current,
          paneId,
          nextConversationId,
          nextMaxHistoryId,
          CURRENT_HISTORY_WINDOW,
          { fresh: true },
        );
        maxLoadedIdRef.current = nextMaxHistoryId;
        setHasMore(lo > 1);
        setNextBefore(lo);
        return buildTurnsFromRawItems(rawItems);
      })
      .then((latestItems) => {
        if (cancelled || requestSeq !== requestSeqRef.current || !latestItems) return;
        setItems(latestItems);
      })
      .catch(() => {
        if (cancelled || requestSeq !== requestSeqRef.current) return;
        setItems([]);
        setHasMore(false);
        setNextBefore(null);
        setConversationId('');
      })
      .finally(() => {
        // Gate on `cancelled` ONLY — not requestSeq (INV-5): a concurrent
        // loadMore/softRebind bumps requestSeqRef; bailing here would strand
        // committedReadyRef=false forever and kill the poll loop.
        if (cancelled) return;
        committedReadyRef.current = true;
        if (firstReplyDoneRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paneId]);

  // Write-back to the RN cache so the next open paints instantly (web lines 376-388).
  useEffect(() => {
    if (!open || !paneId || loading || !items.length || !conversationId) return;
    let minId = 0;
    for (const t of items) {
      const id = Number(t?.history_id || 0);
      if (id > 0 && (minId === 0 || id < minId)) minId = id;
    }
    historyCache.put(paneId, {
      conversationId,
      maxId: maxLoadedIdRef.current,
      minId,
      hasMore,
      turns: items,
    });
  }, [open, paneId, items, conversationId, model, hasMore, nextBefore, loading, liveTurn]);

  // Refs so the poll effect's onNudge/onStreamDelta can be reached from the
  // top-level `pending`-watching effects and handleOutcomeRetry (the RN analog of
  // web's window 'cicy:current-history-refresh' listener).
  const nudgeFnRef = useRef<(detail: { text?: string }) => void>(() => {});
  const cancelOptimisticFnRef = useRef<() => void>(() => {});
  const streamDeltaFnRef = useRef<(detail: StreamDeltaDetail) => void>(() => {});

  // ── Part 2: poll reply.json (see the web file's long comment). ───────────────
  useEffect(() => {
    if (!open || !paneId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSig = '';
    let pollInFlight = false;
    let lastPollStartAt = 0;
    let regressStreak = 0;

    // Event-driven current-reply — never a standing idle loop:
    //   • OPEN(规矩一)— 打开聊天,cicy 或非 cicy 走同一条路:committed 窗口
    //     (open effect)+ 这里立即跑一趟 reply.json 完整快照,一次性拿到那一刻
    //     最完整的记录,不按 agent 类型分叉。
    //   • IN-FLIGHT — 快照说回复没完(!complete)才按 ACTIVE 节奏跟进,完成即停。
    //   • EVENTS — WS 事件、用户发送、回前台各自再触发一趟同样的快照。
    //   空闲聊天窗保持零请求(旧的 2.5s 永动 idle 轮询不再存在)。

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void poll(); }, ms);
    };

    const revealOnce = () => {
      if (firstReplyDoneRef.current) return;
      firstReplyDoneRef.current = true;
      if (committedReadyRef.current) setLoading(false);
    };

    const poll = async () => {
      if (cancelled || pollInFlight) return;
      if (!committedReadyRef.current) { schedule(CURRENT_HISTORY_POLL_WAIT_MS); return; }
      pollInFlight = true;
      lastPollStartAt = Date.now();
      try {
        const data: CurrentReplyResp = await apiRef.current.getCurrentReply(paneId);
        if (cancelled) return;
        const cid = String(data?.conversation_id || '').trim();

        const answerId = Number(data?.history_id || 0);
        const complete = !!data?.complete;
        const replyStatus = String(data?.status || '').trim().toLowerCase();
        const replyFailed = replyStatus === 'failed' || replyStatus === 'fail' || replyStatus === 'error';
        const replyMaxId = answerId > 0 ? answerId - 1 : 0;
        const replyInFlight = answerId > 0 && !complete && !replyFailed;
        replyInFlightRef.current = replyInFlight;
        // INV-10: emit busy BEFORE any rotation early-return.
        emitBusy(optimisticActiveRef.current || replyInFlight);

        if (clearedConvIdRef.current) {
          if (cid && cid === clearedConvIdRef.current) {
            schedule(CURRENT_HISTORY_POLL_ACTIVE_MS);
            return;
          }
          clearedConvIdRef.current = '';
        }

        if (conversationId && cid && cid !== conversationId) {
          revealOnce();
          await softRebind(cid);
          // INV-6: ALWAYS reschedule after a rotation.
          schedule(CURRENT_HISTORY_POLL_WAIT_MS);
          return;
        }
        if (cid && !conversationId) setConversationId((prev) => prev || cid);
        const replyCid = String(data?.reply_conversation_id || '').trim();

        if (answerId <= 0) {
          if (liveTurnRef.current) { clearLiveTurn(); lastSig = ''; }
          revealOnce();
          // 刚发出 q、后端还没建 reply → 继续跟到它出现;真空闲则停(零请求)。
          if (optimisticActiveRef.current) schedule(CURRENT_HISTORY_POLL_ACTIVE_MS);
          return;
        }

        let pendingTail: { tail: HistoryTurn[]; newMax: number } | null = null;
        if (replyMaxId > maxLoadedIdRef.current) {
          pendingTail = await fetchTailBeyondBoundary();
          if (cancelled) return;
        }
        const boundary = pendingTail ? pendingTail.newMax : maxLoadedIdRef.current;

        const answer = String(data?.answer || '');
        const thinking = String(data?.thinking || '');
        const hasContent = !!(answer || thinking);
        if (compactingRef.current && complete && !hasContent
          && Date.now() - compactingTsRef.current > 1500) {
          setCompacting(false);
        }
        const sameConversation = !replyCid || !conversationId || replyCid === conversationId;
        const effectiveAnswerId = (!complete && !replyFailed)
          ? Math.max(answerId, boundary + 1)
          : answerId;
        const isSlashAck = String(data?.turn_id || '') === 'slash-ack';
        const staleTerminal = (isSlashAck || replyFailed) && optimisticActiveRef.current;
        const attach = sameConversation && effectiveAnswerId > boundary && (hasContent || !complete)
          && !staleTerminal
          && replyAnswersRealQuestion(String((data as any)?.question ?? ''));

        // INV-4: ONE synchronous commit for boundary + tail.
        if (pendingTail) {
          const tail = pendingTail.tail;
          setItems((prev) => normalizeHistoryTurns([...prev, ...tail]));
          maxLoadedIdRef.current = pendingTail.newMax;
        }
        if (attach) {
          const turnId = String(data?.turn_id || '');
          const status = String(data?.status || 'thinking').trim() || 'thinking';
          const evModel = String(data?.model || '').trim();
          const liveItems: any[] = Array.isArray((data as any)?.items) ? (data as any).items : [];
          const sig = `${turnId}:${effectiveAnswerId}:${status}:${String(data?.updated_at || '')}:${thinking.length}:${answer.length}:${liveItems.length}:${JSON.stringify(liveItems.map((it: any) => [it?.type, String(it?.thinking || it?.text || '').length, it?.name || '']))}`;
          if (sig !== lastSig) {
            lastSig = sig;
            const steps = replyItemsToSteps(liveItems, thinking, answer);
            // INV-3: same turn only moves forward. A snapshot shorter than the
            // WS-ahead tail (same turn, fewer chars, no new tool) → keep the
            // ahead version, only re-slot the id. Self-heals after 3 regressions.
            const prevLive = liveTurnRef.current;
            let regressed = false;
            if (!complete && prevLive && turnId && turnId === liveTurnIdRef.current) {
              const prevSize = liveStepsContentSize(prevLive.steps);
              const nextSize = liveStepsContentSize(steps);
              regressed = nextSize.textLen < prevSize.textLen && nextSize.toolCount <= prevSize.toolCount;
            }
            if (regressed) {
              regressStreak += 1;
              if (regressStreak >= 3) regressed = false;
            } else {
              regressStreak = 0;
            }
            liveTurnIdRef.current = turnId;
            if (!complete && !replyFailed) onReplyInFlightRef.current?.();
            else onReplyDoneRef.current?.();
            if (regressed && prevLive) {
              if (Number(prevLive.history_id || 0) !== effectiveAnswerId) {
                liveTurnRef.current = { ...prevLive, history_id: effectiveAnswerId };
                setLiveTurn(liveTurnRef.current);
              }
            } else {
              liveTurnRef.current = {
                history_id: effectiveAnswerId,
                conversation_id: cid || conversationId,
                role: 'assistant',
                q: '',
                text: '',
                a: answer,
                steps,
                status,
                model: evModel || model,
              };
              setLiveTurn(liveTurnRef.current);
            }
          }
        } else if (liveTurnRef.current) {
          clearLiveTurn();
          lastSig = '';
        }
        revealOnce();
        // 没完成才跟进;完成即停 —— 下一趟由事件(WS/发送/回前台/重开)触发。
        if (!complete) schedule(CURRENT_HISTORY_POLL_ACTIVE_MS);
      } catch {
        if (!cancelled) {
          revealOnce();
          // 出错时只有"正在等回复"才按 IDLE 节奏重试;空闲态不无限重试。
          if (replyInFlightRef.current || optimisticActiveRef.current) schedule(CURRENT_HISTORY_POLL_IDLE_MS);
        }
      } finally {
        pollInFlight = false;
      }
    };

    // ===== WS 流式直推(仅 consumeWsDeltas / cicy)=====
    const requestPollSoon = () => {
      if (cancelled) return;
      const since = Date.now() - lastPollStartAt;
      schedule(since >= 180 ? 0 : 180 - since);
    };
    const appendStreamDelta = (kind: 'text' | 'thinking', delta: string) => {
      const lt = liveTurnRef.current;
      if (!lt) { requestPollSoon(); return; }
      const steps = Array.isArray(lt.steps) ? [...lt.steps] : [];
      const last: any = steps[steps.length - 1];
      if (last && last.type === kind) {
        const prevText = String(last.text || '');
        if (delta.length >= 6 && prevText.endsWith(delta)) return;
        steps[steps.length - 1] = { ...last, text: `${prevText}${delta}` } as HistoryStep;
      } else {
        steps.push({ type: kind, text: delta } as HistoryStep);
      }
      liveTurnRef.current = { ...lt, steps, status: kind === 'thinking' ? 'thinking' : 'streaming' };
      onReplyInFlightRef.current?.();
      setLiveTurn(liveTurnRef.current);
    };
    const onStreamDelta = (d: StreamDeltaDetail) => {
      const aid = String(d.agent_id || '').trim();
      if (!aid) return;
      if (aid !== paneId && !paneId.endsWith(aid) && !aid.endsWith(paneId)) return;
      if (!consumeWsDeltas) {
        // 非 cicy:delta 不直拼(web CodingAgentHistoryView 同款,靠快照跟进),
        // 但 status_change / current_updated 仍当唤醒 —— 别的客户端发起的新回合
        // 也能立即触发一趟快照,而不是等回前台。
        if (!String(d.delta || '')) requestPollSoon();
        return;
      }
      const turnId = String(d.turn_id || '').trim();
      if (turnId && liveTurnIdRef.current && turnId !== liveTurnIdRef.current) { requestPollSoon(); return; }
      const delta = String(d.delta || '');
      const kind = d.kind === 'thinking' ? 'thinking' : (d.kind === 'text' ? 'text' : '');
      if (delta && kind) { appendStreamDelta(kind as 'text' | 'thinking', delta); return; }
      const status = String(d.status || '').toLowerCase();
      if (status === 'tool_use' || status === 'tool_call' || status === 'working') requestPollSoon();
      else if (!liveTurnRef.current) requestPollSoon();
    };
    streamDeltaFnRef.current = onStreamDelta;

    // onNudge — RN analog of the window 'cicy:current-history-refresh' listener.
    // Driven by the `pending` prop (a send) and by handleOutcomeRetry (bare).
    const onNudge = (detail: { text?: string }) => {
      const qText = String(detail.text || '').trim();
      const isSlashCommand = /^\/\w+(\s|$)/.test(qText);
      if (/^\/compact(\s|$)/.test(qText)) { compactingTsRef.current = Date.now(); setCompacting(true); }
      if (/^\/clear(\s|$)/.test(qText)) {
        clearedConvIdRef.current = conversationIdRef.current;
        requestSeqRef.current += 1;
        maxLoadedIdRef.current = 0;
        clearLiveTurn();
        setOptimisticQ(null);
        setItems([]);
        setHasMore(false);
        setNextBefore(null);
      }
      if (qText && !isSlashCommand) {
        // 上一轮失败 → 新 q 就地覆盖(后端 dropTrailingFailedTurnLocked)。删失败 q + a,
        // maxLoadedIdRef 回退到失败 q 之前,否则新 q 复用旧 id → fetchTail 永不重拉。
        let base = itemsRef.current;
        const lastLive = liveTurnRef.current;
        const liveFailed = !!lastLive && /fail|error/i.test(String((lastLive as any)?.status || ''));
        const committedFailed = base.length > 0 && String(base[base.length - 1]?.outcome || '') === 'error';
        if (committedFailed || liveFailed) {
          let cut = base.length;
          for (let i = base.length - 1; i >= 0; i--) { if (base[i]?.role === 'user') { cut = i; break; } }
          base = base.slice(0, cut);
          setItems(base);
          maxLoadedIdRef.current = Number(base[base.length - 1]?.history_id || 0);
          clearLiveTurn();
        }
        let maxUserId = 0;
        for (const it of base) if (it?.role === 'user') maxUserId = Math.max(maxUserId, Number(it?.history_id || 0));
        optimisticBaselineUserIdRef.current = maxUserId;
        setOptimisticQ({ text: qText, ts: Date.now() });
        shouldStickBottomRef.current = true;
      }
      if (timer != null) { clearTimeout(timer); timer = null; }
      void poll();
    };
    nudgeFnRef.current = onNudge;

    // Send failed → retract the optimistic q/a + 压缩中 marker.
    const onCancelOptimistic = () => {
      setOptimisticQ(null);
      setCompacting(false);
    };
    cancelOptimisticFnRef.current = onCancelOptimistic;

    // AppState → kick an immediate poll on resume (web: visibilitychange).
    const appSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      if (timer != null) { clearTimeout(timer); timer = null; }
      void poll();
    });

    void poll();
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
      appSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, open, paneId, model, consumeWsDeltas]);

  // WS delta feed (replaces window 'cicy:agent-stream-delta'/'agent-status-change'
  // listeners). Focus/open-scoped so a closed pane holds no socket. The client
  // routes every event into the poll effect's onStreamDelta (via streamDeltaFnRef,
  // always current) — which gates on consumeWsDeltas internally, exactly like web.
  useEffect(() => {
    if (!open || !paneId) return;
    // Endpoint override (Hub agent) wins; otherwise the active team's creds.
    const store = useAuthStore.getState();
    const serverUrl = endpoint?.serverUrl ?? store.serverUrl;
    const token = endpoint?.token ?? store.token;
    if (!serverUrl || !token) return;
    const clientId = `mobile-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const client = new ChatWsClient({ serverUrl, token, clientId, agentId: paneId });
    const off = client.on((msg) => {
      const d = (msg.data ?? {}) as any;
      if (msg.type === 'ai_chunk') {
        streamDeltaFnRef.current({ agent_id: d.agent_id, turn_id: d.turn_id, delta: String(d.delta ?? ''), kind: 'text' });
      } else if (msg.type === 'thinking_chunk') {
        streamDeltaFnRef.current({ agent_id: d.agent_id, turn_id: d.turn_id, delta: String(d.delta ?? ''), kind: 'thinking' });
      } else if (msg.type === 'status_change') {
        streamDeltaFnRef.current({ agent_id: d.agent_id, turn_id: d.turn_id, status: String(d.status ?? '') });
      } else if (msg.type === 'current_updated') {
        // Server enrichment event — no delta; treat as a poll nudge.
        streamDeltaFnRef.current({ agent_id: d.agent_id, status: 'working' });
      }
    });
    client.connect();
    return () => { off(); client.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paneId, endpoint?.serverUrl, endpoint?.token]);

  // Drive onNudge / onCancelOptimistic from the `pending` prop (the RN send
  // channel, in place of window events). nonce dedups repeated sends.
  const lastNonceRef = useRef<number | null>(null);
  useEffect(() => {
    const pending = opts.pending;
    if (pending === null) { cancelOptimisticFnRef.current(); return; }
    if (!pending) return;
    if (pending.nonce === lastNonceRef.current) return;
    lastNonceRef.current = pending.nonce;
    nudgeFnRef.current({ text: pending.text });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.pending]);

  const loadMore = async () => {
    if (loadingMore || loading || !nextBefore || Number(nextBefore) <= 1 || !conversationId) return;
    const requestPaneId = paneId;
    const requestSeq = ++requestSeqRef.current;
    setLoadingMore(true);
    try {
      const { items: rawItems, lo } = await loadWindowItems(
        apiRef.current,
        paneId,
        conversationId,
        Number(nextBefore) - 1,
        CURRENT_HISTORY_WINDOW,
        { fresh: true },
      );
      if (requestPaneId !== paneId || requestSeq !== requestSeqRef.current) return;
      if (!rawItems.length) {
        setHasMore(false);
        setNextBefore(null);
        return;
      }
      const older = buildTurnsFromRawItems(rawItems);
      setItems((prev) => normalizeHistoryTurns([...older, ...prev]));
      setHasMore(lo > 1);
      setNextBefore(lo);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const canLoadMore = Number(nextBefore || 0) > 1;

  const committedMaxId = useMemo(
    () => items.reduce((m, t) => Math.max(m, Number(t?.history_id || 0)), 0),
    [items],
  );

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => {
    optimisticActiveRef.current = !!optimisticQ;
    if (optimisticQ) emitBusy(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimisticQ]);

  // Optimistic q teardown (real committed q landed, or 60s no-show timeout).
  useEffect(() => {
    if (!optimisticQ) return;
    let maxUserId = 0;
    for (const it of items) if (it?.role === 'user') maxUserId = Math.max(maxUserId, Number(it?.history_id || 0));
    // Content-match fallback: an attachment-only send (`[file](abs)` / `![img](abs)`)
    // can commit as a user turn whose history_id doesn't clear the baseline check
    // (id assignment races the poll), leaving the optimistic bubble duplicated
    // below the committed one. Also drop it when a committed user turn's text
    // equals the optimistic text.
    const optText = optimisticQ.text.trim();
    const textLanded = !!optText && items.some((it) => it?.role === 'user' && String(it?.q ?? '').trim() === optText);
    if (maxUserId > optimisticBaselineUserIdRef.current || textLanded) {
      setOptimisticQ(null);
      return;
    }
    const elapsed = Date.now() - optimisticQ.ts;
    const remaining = Math.max(0, OPTIMISTIC_Q_TIMEOUT_MS - elapsed);
    const timer = setTimeout(() => setOptimisticQ(null), remaining);
    return () => clearTimeout(timer);
  }, [items, optimisticQ]);

  // INV-8: promptOnlyItems memoized on promptList ALONE (stable across polls).
  const promptOnlyItems = useMemo(() =>
    promptList
      .filter((p) => Number(p?.id || 0) > 0 && String(p?.content || '').trim() !== '')
      .map((p) => ({ role: 'user', history_id: p.id, text: p.content, q: p.content, ts: p.ts } as unknown as HistoryTurn)),
    [promptList]);

  // INV-9: displayItems depends on the liveActive BOOLEAN, not the liveTurn object.
  // (Mobile display policy: fully drop system turns + harness-only user turns —
  // there is no SystemNoticeCard on mobile — on top of web's live-tail hiding.)
  const liveActive = !!liveTurn && Number(liveTurn.history_id || 0) > committedMaxId;
  const displayItems = useMemo(() => {
    if (promptsOnly) return promptOnlyItems;
    const visible = items.filter((t) => {
      if (t?.role === 'system') return false;
      if (t?.role === 'user') {
        const q = String((t as any)?.q ?? (t as any)?.text ?? '');
        if (q.trim() && !stripHarnessNoise(q)) return false;
      }
      return true;
    });
    if (!liveActive) return visible;
    let lastUserId = 0;
    for (const t of visible) if (t?.role === 'user') lastUserId = Math.max(lastUserId, Number(t?.history_id || 0));
    return visible.filter((t) => !(t?.role === 'assistant' && Number(t?.history_id || 0) > lastUserId));
  }, [promptsOnly, items, promptOnlyItems, liveActive, committedMaxId]);

  // Recap-on-return is system noise: a harness-only user turn + the assistant
  // recap it triggers. Scans UNFILTERED items (displayItems already dropped the
  // harness q); the drop Set holds identities shared with displayItems.
  const recapResponses = useMemo(() => {
    const drop = new Set<HistoryTurn>();
    let pendingRecap = false;
    for (const t of items) {
      if (t?.role === 'system') continue;
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

  // Re-run the latest cancelled/failed turn. Fire retry, stick to bottom, and
  // nudge the poll so the new reply streams in; clear the spinner after a beat.
  const handleOutcomeRetry = (key: string) => {
    if (!paneId || retryingKey) return;
    setRetryingKey(key);
    shouldStickBottomRef.current = true;
    Promise.resolve(apiRef.current.retryCicyReply(paneId))
      .catch(() => {})
      .finally(() => {
        nudgeFnRef.current({});
        setTimeout(() => setRetryingKey(null), 2000);
      });
  };

  return {
    items,
    liveTurn,
    optimisticQ,
    compacting,
    displayItems,
    committedMaxId,
    promptList,
    loading,
    loadingMore,
    hasMore,
    nextBefore,
    conversationId,
    model,
    pendingUrl,
    setPendingUrl,
    retryingKey,
    recapResponses,
    handleOutcomeRetry,
    loadMore,
    canLoadMore,
    shouldStickBottomRef,
    optimisticBaselineUserIdRef,
  };
}
