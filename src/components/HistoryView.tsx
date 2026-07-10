// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Keyboard, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { assetBrowserUrl, assetUri, isAssetRef } from '@/src/api/upload';
import i18n from '@/src/i18n';
import type { Endpoint } from '@/src/api/http';
import type { HistoryStep, HistoryTurn } from '@/src/api/types';
import { stripHarnessNoise } from '@/src/lib/historyParse';
import { useCurrentHistory } from '@/src/lib/history/useCurrentHistory';
import {
  buildToolCardId,
  cleanToolResult,
  formatToolArg,
  formatToolResult,
  isPatchText,
  parseToolInput,
  shortenToolPath,
  toolBodyContent,
  toolEditDiff,
  toolHeadline,
} from '@/src/lib/history/toolFormat';
import { normalizeAgentType } from '@/src/lib/agentType';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';
import { ImageLightbox } from './ImageLightbox';
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
  /** A reply reached a terminal state (complete/failed) — unlock the composer. */
  onReplyDone?: () => void;
  // Agent type — gates real-time WS delta streaming to cicy (the only type the
  // AI gateway pushes ai_chunk/thinking_chunk for). Others rely on the poll.
  agentType?: string;
  // Reply-in-flight (owned by the composer's hysteresis — set on send, cleared
  // ONLY on a terminal turn). Drives the persistent thinking indicator so it
  // shows continuously from send until cancel/failure/success, never flickering
  // off on a transient per-poll status gap.
  busy?: boolean;
  // Endpoint override — when set, the whole two-part engine targets this
  // server+token instead of the active team. A Hub agent passes its reach_url +
  // node api_token so the same chat serves hub agents. Omit → active team.
  endpoint?: Endpoint | null;
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
// Poll cadence — ONLY while the WS is DOWN (then reply.json polling is the sole
// feed, so it loops like web). With a healthy WS there is NO periodic polling
// at all: fetches are event-driven (a delta with no baseline, a tool round's
// status_change, current_updated, reconnect — each nudges ONE fetch, then the
// loop parks). The single exception is a slow in-flight heartbeat, guarding the
// case where the socket is open but this agent's events never arrive (capture
// gap server-side) — without it the view would freeze mid-turn with no signal.
const POLL_ACTIVE_MS = 500; // WS down + reply streaming — poll is the only feed
const POLL_IDLE_MS = 2500; // WS down + idle — watch for the next q
const POLL_INFLIGHT_HEARTBEAT_MS = 10000; // WS up + turn in flight — sanity only
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
// q's top in content coordinates (for the spacer's belowQ measure).
function turnTopInContent(node: any, turnKey: string): number | null {
  const target = findTurnEl(node, turnKey);
  if (!target || typeof target.getBoundingClientRect !== 'function') return null;
  return node.scrollTop + (target.getBoundingClientRect().top - node.getBoundingClientRect().top);
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
// Content size of a live turn's steps — used by the poll's regress guard to tell
// whether a poll snapshot is BEHIND the (WS-ahead) tail we're already showing.
function liveStepsContentSize(steps: HistoryStep[] | undefined): { textLen: number; toolCount: number } {
  let textLen = 0;
  let toolCount = 0;
  for (const s of steps ?? []) {
    if ((s as any).type === 'tool') toolCount += Array.isArray((s as any).tools) ? (s as any).tools.length : 0;
    else textLen += String((s as any).text ?? '').length;
  }
  return { textLen, toolCount };
}

function isActiveAssistantStatus(s: string): boolean {
  const v = (s || '').toLowerCase();
  // NB: 'thinking' MUST be here. Omitting it meant the reply's initial thinking
  // phase read as "not active", so the answer showed no typing indicator while
  // a stray one appeared elsewhere.
  // 'working' is the gateway's inter-round status while the CLI executes a tool
  // (no live HTTP). Missing it meant streaming=false exactly during the tool-run
  // gap — the running (●) indicator never showed when a tool was actually running.
  return v === 'thinking' || v === 'streaming' || v === 'pending' || v === 'tool_use' || v === 'running' || v === 'in_progress' || v === 'working';
}

export function HistoryView({ agentId, pending, onReplyInFlight, onReplyDone, agentType, busy, endpoint }: Props) {
  const theme = useTheme();
  // cicy 走 WS 直推加速(delta 逐字直拼);非 cicy 纯 poll loop(consumeWsDeltas:false),
  // 与 cicy-code app 的 CicyHistoryView / CodingAgentHistoryView 分流一致。
  const consumeWsDeltas = normalizeAgentType(agentType) === 'cicy';
  const h = useCurrentHistory({
    paneId: agentId,
    open: true,
    promptsOnly: false,
    hideTools: false,
    agentType: String(agentType ?? ''),
    consumeWsDeltas,
    pending: pending ?? null,
    onReplyInFlight,
    onReplyDone,
    endpoint: endpoint ?? null,
  });
  const {
    displayItems,
    liveTurn,
    committedMaxId,
    loading,
    loadingMore,
    canLoadMore,
    loadMore,
    recapResponses,
    optimisticQ,
    optimisticBaselineUserIdRef,
    handleOutcomeRetry,
    shouldStickBottomRef,
  } = h;

  const liveVisible = !!liveTurn && Number(liveTurn.history_id ?? 0) > committedMaxId;
  const liveVisibleRef = useRef(false);
  liveVisibleRef.current = liveVisible;

  // ── Native ChatGPT-style stick-to-bottom scroll (NO top-anchor spacer — that
  // web-DOM mechanism is gone). Land at the newest turn on open, then follow the
  // bottom while the user is parked there; release on scroll-up; auto-load older
  // near the top (one load per approach). ─────────────────────────────────────
  const scrollRef = useRef<ScrollView>(null);
  const didInitialScrollRef = useRef(false);
  const autoLoadArmedRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const showJumpRef = useRef(false);
  const loadMoreFnRef = useRef(loadMore);
  loadMoreFnRef.current = loadMore;

  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const y = contentOffset.y;
      const dist = contentSize.height - y - layoutMeasurement.height;
      shouldStickBottomRef.current = dist <= 80;
      const jump = dist > 300;
      if (jump !== showJumpRef.current) {
        showJumpRef.current = jump;
        setShowJump(jump);
      }
      if (!didInitialScrollRef.current) return;
      if (y > 300) autoLoadArmedRef.current = true;
      if (y <= 80 && autoLoadArmedRef.current) {
        autoLoadArmedRef.current = false;
        loadMoreFnRef.current();
      }
    },
    [shouldStickBottomRef],
  );

  // User grabbed the list → stop following IMMEDIATELY. During streaming, content
  // grows every frame and onContentSizeChange can fire before onScroll updates the
  // stick flag, reading a stale stick=true and yanking to the bottom mid-drag (the
  // "拖动时还一直落底" bug). Disengaging on drag-start beats that race; onScroll then
  // re-engages only if the user settles back near the bottom.
  const onScrollBeginDrag = useCallback(() => {
    shouldStickBottomRef.current = false;
  }, [shouldStickBottomRef]);

  const onContentSizeChange = useCallback(() => {
    // Land at / follow the bottom. While the live tail types, content grows every
    // frame — jump-follow (not animated, which would restart 60×/s and stutter).
    if (!didInitialScrollRef.current || shouldStickBottomRef.current) {
      const animated = didInitialScrollRef.current && !liveVisibleRef.current;
      scrollRef.current?.scrollToEnd({ animated });
      didInitialScrollRef.current = true;
    }
  }, [shouldStickBottomRef]);

  const jumpToLatest = useCallback(() => {
    shouldStickBottomRef.current = true;
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [shouldStickBottomRef]);

  // Sending a prompt → snap to the bottom (a fresh nonce means a new send).
  useEffect(() => {
    if (pending) jumpToLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.nonce]);

  // Keyboard opening → snap to the bottom so the latest turn stays in view above it.
  useEffect(() => {
    const evt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const sub = Keyboard.addListener(evt, () => jumpToLatest());
    return () => sub.remove();
  }, [jumpToLatest]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }

  const isEmpty = displayItems.length === 0 && !liveVisible;
  // Optimistic q shows until the real committed q (id > baseline) lands.
  const optimisticPending =
    !!optimisticQ &&
    !displayItems.some((t) => t?.role === 'user' && Number(t?.history_id ?? 0) > optimisticBaselineUserIdRef.current);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={styles.list}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      >
        {/* Load-earlier at the TOP: tap or auto-fire when scrolled near the top
            (one load per approach → no "一打开全打开了"). */}
        {isEmpty ? null : loadingMore ? (
          <View style={styles.loadMoreRow}>
            <ActivityIndicator size="small" color={theme.textMuted} />
          </View>
        ) : canLoadMore ? (
          <View style={styles.loadMoreRow}>
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

        {/* Part 1 — committed turns (recap responses dropped; in-flight assistant
            of the current round suppressed inside displayItems). */}
        {displayItems.map((t, i) => {
          if (recapResponses.has(t)) return null;
          const isLastRow = !liveVisible && i === displayItems.length - 1;
          return (
            <View key={`row-${t.history_id ?? t.turn_id ?? i}`}>
              <Turn
                turn={t}
                isLast={isLastRow}
                onRetry={
                  t.outcome && t.outcome !== 'blocked' && isLastRow
                    ? () => handleOutcomeRetry(String(t.history_id ?? t.turn_id ?? i))
                    : undefined
                }
              />
            </View>
          );
        })}

        {/* Part 2 — live tail (answer-only), rendered SEPARATELY after committed. */}
        {liveVisible && liveTurn ? (
          <View key="live">
            <Turn turn={liveTurn} isLast />
          </View>
        ) : null}

        {/* Optimistic q — the sent question paints instantly; drops the frame the
            real committed q lands. MUST render after the live tail (cicy lazy
            migration: a1 is still the live tail when q2 is sent). */}
        {optimisticPending ? (
          <View key={`opt-${optimisticQ!.ts}`} style={{ gap: spacing.md }}>
            <QuestionBubble text={optimisticQ!.text} />
          </View>
        ) : null}

        {/* Persistent thinking indicator: from send until the turn resolves. `busy`
            is the composer hysteresis (set on send, cleared only on terminal). */}
        {busy ? (
          <View style={{ paddingRight: spacing.lg }}>
            <TypingDots />
          </View>
        ) : null}
      </ScrollView>

      {showJump ? (
        <PressableScale
          onPress={jumpToLatest}
          haptic
          scaleTo={0.9}
          accessibilityLabel={i18n.t('chat.jumpToLatest')}
          style={[styles.jumpChip, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Ionicons name="arrow-down" size={18} color={theme.text} />
        </PressableScale>
      ) : null}
    </View>
  );
}

// User question bubble = web's CollapsibleQ, minus the system fold: leading
// harness blocks (system-reminder / recap / continuation / command echoes) are
// DROPPED — only the real question renders.
function copyToClipboard(text: string) {
  Clipboard.setStringAsync(text).catch(() => {});
  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

type QMedia = { url: string; name: string; isImage: boolean; isVideo: boolean };

// Pull standalone attachment lines (uploaded images/files, embedded as
// `![name](abs)` / `[name](abs)`) out of the question so they render as
// thumbnails / download cards — same as web's MarkdownBlock in CollapsibleQ —
// instead of showing raw markdown text. The leftover prose stays in the bubble.
function splitQuestionMedia(text: string): { body: string; media: QMedia[] } {
  const media: QMedia[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(!?)\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (m) {
      const url = m[3];
      const isVideo = /\.(mp4|mov|m4v|webm|3gp|mkv)(\?|$)/i.test(url) || m[2].startsWith('🎬');
      if (isAssetRef(url) || (/^https?:/.test(url) && (m[1] === '!' || isVideo))) {
        media.push({ url, name: m[2].replace(/^🎬\s*/, ''), isImage: m[1] === '!' && !isVideo, isVideo });
        continue;
      }
    }
    // Bare attachment line (no markdown wrapper) — e.g. an `image://…` scheme or
    // a raw absolute asset path pasted into the composer. Render it as a
    // thumbnail/card too instead of leaking the raw path into the bubble.
    const bare = line.trim();
    if (bare && (isAssetRef(bare) || /^(image|file):\/\//i.test(bare))) {
      const isVideo = /\.(mp4|mov|m4v|webm|3gp|mkv)(\?|$)/i.test(bare);
      const isImage = /^image:\/\//i.test(bare) || /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)(\?|$)/i.test(bare);
      media.push({ url: bare, name: (bare.split(/[/\\]/).pop() || 'attachment').replace(/\?.*$/, ''), isImage: isImage && !isVideo, isVideo });
      continue;
    }
    kept.push(line);
  }
  return { body: kept.join('\n').trim(), media };
}

function QuestionBubble({ text }: { text: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  // Harness/system blocks (system-reminder / task-notification / recap /
  // continuation) are stripped wherever they appear — leading, embedded, or
  // trailing — so the display layer never shows system content.
  const remaining = useMemo(() => stripHarnessNoise(text), [text]);
  const { body, media } = useMemo(() => splitQuestionMedia(remaining), [remaining]);
  if (!remaining) return null;
  // Long-press → copy (RN text selection is fiddly per-block; ChatGPT/Claude
  // mobile treat long-press copy as table stakes).
  const onCopy = () => {
    copyToClipboard(body || remaining);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <View style={{ gap: spacing.sm }}>
      {body ? (
        <View style={styles.qRow}>
          <PressableScale onLongPress={onCopy} scaleTo={0.98} style={[styles.qBubble, { backgroundColor: theme.accent }]}>
            <Text style={{ color: theme.accentText, fontSize: 15, lineHeight: 22 }} selectable>
              {body}
            </Text>
          </PressableScale>
        </View>
      ) : null}
      {/* User's own uploaded attachments — right-aligned to sit under their bubble. */}
      {media.map((mm, i) => (
        <View key={`qm${i}`} style={{ alignSelf: 'flex-end', maxWidth: '82%' }}>
          <MediaBlock url={mm.url} name={mm.name} isImage={mm.isImage} isVideo={mm.isVideo} theme={theme} />
        </View>
      ))}
      {copied ? (
        <Text variant="caption" tone="faint" style={{ alignSelf: 'flex-end' }}>
          {i18n.t('chat.copied')}
        </Text>
      ) : null}
    </View>
  );
}

// Web's ANSWER_RENDER_CAP: a single agentic reply can be 40+ tool rounds —
// rendering every step of every committed turn at once is what causes the jank,
// especially on phone CPUs. Cap to the LAST 8 with a "show all" expander.
const STEP_RENDER_CAP = 8;

// A cicy "turn produced no reply" record (cancel / post-retry failure / blocked):
// danger-tinted notice + 重试 on the latest turn. Web's OutcomeNoticeCard.
function OutcomeCard({ turn, onRetry }: { turn: HistoryTurn; onRetry?: (() => Promise<void> | void) | null }) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const danger = turn.outcome === 'error';
  return (
    <View style={[styles.outcomeCard, { borderColor: danger ? theme.danger : theme.border, backgroundColor: theme.surface }]}>
      <Ionicons
        name={turn.outcome === 'cancelled' ? 'stop-circle-outline' : 'alert-circle-outline'}
        size={16}
        color={danger ? theme.danger : theme.textMuted}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text variant="callout" tone={danger ? 'danger' : 'muted'}>
          {turn.text || turn.a || ''}
        </Text>
        {turn.outcomeDetail ? (
          <Text variant="caption" tone="faint" numberOfLines={3}>
            {turn.outcomeDetail}
          </Text>
        ) : null}
      </View>
      {onRetry ? (
        <PressableScale
          disabled={busy}
          haptic
          scaleTo={0.94}
          onPress={() => {
            if (busy) return;
            setBusy(true);
            Promise.resolve(onRetry())
              .catch(() => {})
              .finally(() => setTimeout(() => setBusy(false), 2000));
          }}
          style={[styles.outcomeRetry, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.textMuted} />
          ) : (
            <Text variant="caption">{i18n.t('chat.retry')}</Text>
          )}
        </PressableScale>
      ) : null}
    </View>
  );
}

function Turn({
  turn,
  isLast,
  onRetry,
}: {
  turn: HistoryTurn;
  isLast: boolean;
  onRetry?: (() => Promise<void> | void) | null;
}) {
  const theme = useTheme();
  const [showAllSteps, setShowAllSteps] = useState(false);
  // System/developer notices never render — display layer filters them fully.
  if (turn.role === 'system') return null;
  if (turn.outcome) {
    return (
      <View style={{ gap: spacing.md }}>
        {turn.q ? <QuestionBubble text={turn.q} /> : null}
        <OutcomeCard turn={turn} onRetry={onRetry} />
      </View>
    );
  }
  const status = (turn.status ?? '').toLowerCase();
  // Single source of truth for "reply still running" — includes 'thinking'
  // (see isActiveAssistantStatus). The typing indicator lives ONLY here, below
  // the answer; there is no separate optimistic-slot indicator.
  const streaming = isLast && isActiveAssistantStatus(status);

  // A pure-question turn (no answer yet) must NOT render the empty answer block —
  // its leading gap left a large blank between the q and the next (answer) turn
  // ("q和a 之间很大间隔"). Only render the answer section when it has content.
  const hasAnswer = (turn.steps?.length ?? 0) > 0 || !!turn.a || streaming;
  const steps = turn.steps ?? [];
  const capped = !showAllSteps && steps.length > STEP_RENDER_CAP;
  // Keys stay the ORIGINAL index so the visible window sliding during streaming
  // doesn't remount every Step each poll.
  const offset = capped ? steps.length - STEP_RENDER_CAP : 0;
  const visibleSteps = capped ? steps.slice(offset) : steps;
  return (
    <View style={{ gap: spacing.md }}>
      {turn.q ? <QuestionBubble text={turn.q} /> : null}

      {hasAnswer ? (
        <View style={{ gap: spacing.sm, paddingRight: spacing.lg }}>
          {capped ? (
            <PressableScale
              onPress={() => setShowAllSteps(true)}
              haptic
              scaleTo={0.97}
              style={[styles.stepsExpander, { borderColor: theme.border, backgroundColor: theme.surface }]}
            >
              <Ionicons name="chevron-up" size={13} color={theme.textFaint} />
              <Text variant="caption" tone="faint">
                {i18n.t('chat.showAllSteps', { count: steps.length })}
              </Text>
            </PressableScale>
          ) : null}
          {visibleSteps.map((step, i) => (
            <Step
              key={offset + i}
              step={step}
              streaming={streaming && offset + i === steps.length - 1}
              turnKey={turn.history_id ?? 'live'}
              stepIndex={offset + i}
            />
          ))}

          {/* If the API only sent a flat `a` and no steps, render it as a text block. */}
          {(!turn.steps || turn.steps.length === 0) && turn.a ? <RichText text={turn.a} /> : null}
          {/* No trailing dots here — the persistent busy-gated thinking indicator
              (rendered once, after the live tail) is the single source. */}
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
  function Step({ step, streaming, turnKey, stepIndex }: { step: HistoryStep; streaming: boolean; turnKey: string | number; stepIndex: number }) {
    if (step.type === 'thinking' && typeof step.text === 'string') {
      return <ThinkingBlock text={step.text} streaming={streaming} />;
    }
    if (step.type === 'text' && typeof step.text === 'string') {
      return <RichText text={step.text} />;
    }
    if (step.type === 'tool' && Array.isArray(step.tools)) {
      return <ToolStrip tools={step.tools as ToolData[]} turnKey={turnKey} stepIndex={stepIndex} streaming={streaming} />;
    }
    return null;
  },
  (a, b) => {
    if (a.streaming !== b.streaming) return false;
    if (a.turnKey !== b.turnKey || a.stepIndex !== b.stepIndex) return false;
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
      {/* No header label — the left rail + muted tone already read as
          "thinking"; the row is just the tap-to-expand affordance. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
        <Text variant="callout" tone="muted" style={{ flex: 1 }}>
          {expanded ? text : preview}
        </Text>
        <Text variant="caption" tone="faint">
          {expanded ? '▲' : '▼'}
        </Text>
      </View>
    </PressableScale>
  );
}

type ToolData = { name?: string; arg?: string; result?: string; isError?: boolean };

const TOOL_BODY_MAX = 4000; // cap expanded text so a huge result can't blow up the row

// Expanded/collapsed state per tool card, keyed by a stable id (turn + step +
// tool index + name) — FlatList recycles rows, so component state alone loses
// the open state as soon as the card scrolls out of the window.
const toolCardOpenState = new Map<string, boolean>();

function ToolStrip({ tools, turnKey, stepIndex, streaming }: { tools: ToolData[]; turnKey: string | number; stepIndex: number; streaming: boolean }) {
  return (
    <View style={{ gap: spacing.sm }}>
      {tools.map((t, i) => {
        const toolId = buildToolCardId(turnKey, stepIndex, t, i);
        // In the streaming step, a tool with no result yet is executing right
        // now (the CLI runs it and feeds the output back next round).
        const running = streaming && !String(t?.result ?? '').trim() && t?.isError !== true;
        return <ToolCard key={toolId} tool={t} toolId={toolId} running={running} />;
      })}
    </View>
  );
}

// Complete tool card (ported from cicy-code's ToolCard): collapsed shows a
// status glyph (✓ / ✗ failed / ● running) + tool name + a one-line headline
// (the file / command / pattern the user actually scans for). Tapping expands
// a HUMANIZED body — command as code, Edit as an old/new diff, patch text as
// colored lines, JSON args/results as readable key: value lines — never raw JSON.
function ToolCard({ tool, toolId, running }: { tool: ToolData; toolId: string; running?: boolean }) {
  const theme = useTheme();
  const [open, setOpen] = useState(() => toolCardOpenState.get(toolId) ?? false);
  useEffect(() => {
    setOpen(toolCardOpenState.get(toolId) ?? false);
  }, [toolId]);
  const name = String(tool?.name ?? 'tool').trim() || 'tool';
  const isError = tool?.isError === true;
  const input = parseToolInput(tool);
  const editDiff = toolEditDiff(tool);
  const hasDiff = !!editDiff && !!(editDiff.old || editDiff.new);
  const patchArg = String(tool?.arg || '');
  const showPatchArg = open && !!patchArg && isPatchText(patchArg);
  const headline = toolHeadline(tool);
  const command = input ? String(input.command ?? input.cmd ?? '').trim() : '';
  const bodyContent = toolBodyContent(tool);
  const displayResult = cleanToolResult(formatToolResult(tool));
  // For a short single-line command the headline already shows it in full —
  // repeating it in the body is pure duplication, but only suppress when the
  // body has something ELSE to show (else expanding looks like a no-op).
  const hasOtherBody = !!displayResult || hasDiff || !!bodyContent || (!!patchArg && isPatchText(patchArg));
  const commandRedundant = hasOtherBody && !!command && !command.includes('\n') && command.length <= 80 && shortenToolPath(command) === headline;
  // 兜底参数:只在没有 command / content / diff / patch 这些专门渲染时,才平铺
  // 人话化后的剩余参数(如 Grep/Glob/Task)——绝不显示原始 JSON。
  const genericArg = (!command && !bodyContent && !hasDiff && !isPatchText(patchArg)) ? formatToolArg(tool) : '';
  const hasBody = hasOtherBody || (!!command && !commandRedundant) || !!genericArg;
  const clamp = (s: string) => (s.length > TOOL_BODY_MAX ? s.slice(0, TOOL_BODY_MAX) + '\n…' : s);
  const toggleOpen = () => {
    if (!hasBody) return;
    setOpen((v) => {
      const next = !v;
      toolCardOpenState.set(toolId, next);
      return next;
    });
  };

  return (
    <View style={[styles.toolCard, { borderColor: isError ? theme.danger : theme.border, backgroundColor: theme.surface }]}>
      <PressableScale
        onPress={toggleOpen}
        haptic={hasBody}
        scaleTo={0.99}
        style={styles.toolHeader}
      >
        <Text variant="caption" style={{ color: isError ? theme.danger : running ? theme.warn : theme.ok }}>
          {isError ? '✗' : running ? '●' : '✓'}
        </Text>
        <View style={[styles.toolNameChip, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {name}
          </Text>
        </View>
        {isError ? (
          <Text variant="caption" style={{ color: theme.danger }}>
            {i18n.t('chat.toolFailed')}
          </Text>
        ) : null}
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
          {showPatchArg ? (
            <PatchBlock text={clamp(patchArg)} />
          ) : command && !commandRedundant ? (
            <ToolCode text={clamp(command)} color={theme.textMuted} />
          ) : bodyContent ? (
            <ToolCode text={clamp(bodyContent)} color={theme.textMuted} />
          ) : genericArg ? (
            <ToolCode text={clamp(genericArg)} color={theme.textMuted} />
          ) : null}
          {hasDiff && editDiff ? (
            <DiffBlock oldText={clamp(editDiff.old)} newText={clamp(editDiff.new)} />
          ) : displayResult ? (
            <ToolCode text={clamp(displayResult)} color={isError ? theme.danger : theme.text} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Edit old→new as red/green line rows (mirrors web's diff rendering) in a
// horizontally-scrolling block — long lines never soft-wrap.
function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.toolCode, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
      <ScrollView horizontal style={{ width: '100%' }}>
        <View>
          {oldText ? oldText.split('\n').map((line, i) => (
            <Text key={`o${i}`} selectable style={[typeScale.mono, styles.diffLine, { color: theme.danger, backgroundColor: theme.danger + '14' }, Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as any) : null]}>
              {`- ${line}`}
            </Text>
          )) : null}
          {newText ? newText.split('\n').map((line, i) => (
            <Text key={`n${i}`} selectable style={[typeScale.mono, styles.diffLine, { color: theme.ok, backgroundColor: theme.ok + '14' }, Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as any) : null]}>
              {`+ ${line}`}
            </Text>
          )) : null}
        </View>
      </ScrollView>
    </View>
  );
}

// codex apply_patch text with per-line add/remove coloring; markers and hunk
// headers are dropped (mirrors web's renderPatchLine).
function PatchBlock({ text }: { text: string }) {
  const theme = useTheme();
  const lines = text.split('\n').filter((l) => !l.startsWith('*** Begin Patch') && !l.startsWith('*** End Patch') && !l.startsWith('@@'));
  return (
    <View style={[styles.toolCode, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
      <ScrollView horizontal style={{ width: '100%' }}>
        <View>
          {lines.map((line, i) => {
            const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('*** ') ? 'marker' : 'ctx';
            const color = kind === 'add' ? theme.ok : kind === 'del' ? theme.danger : kind === 'marker' ? theme.text : theme.textFaint;
            const bg = kind === 'add' ? theme.ok + '14' : kind === 'del' ? theme.danger + '14' : 'transparent';
            const shown = kind === 'marker' ? line.replace('*** Update File:', 'Update:') : line;
            return (
              <Text key={i} selectable style={[typeScale.mono, styles.diffLine, { color, backgroundColor: bg }, Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as any) : null]}>
                {shown || ' '}
              </Text>
            );
          })}
        </View>
      </ScrollView>
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
          <CodeBlock key={i} lang={seg.lang} text={seg.text} />
        ) : (
          <MarkdownBlocks key={i} text={seg.text} theme={theme} />
        ),
      )}
    </View>
  );
}

// Fenced code in an ANSWER: header (lang + copy) + horizontally-scrolling body.
// Long lines used to soft-wrap into unreadable stair-steps — ToolCode already
// solved this (white-space: pre + horizontal ScrollView); reuse the pattern.
function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View style={[styles.codeBlock, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <Text variant="caption" tone="faint" style={{ flex: 1 }}>
          {lang || 'code'}
        </Text>
        <PressableScale
          onPress={() => {
            copyToClipboard(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          hitSlop={8}
          scaleTo={0.9}
        >
          {copied ? (
            <Text variant="caption" tone="faint">
              {i18n.t('chat.copied')}
            </Text>
          ) : (
            <Ionicons name="copy-outline" size={13} color={theme.textFaint} />
          )}
        </PressableScale>
      </View>
      <ScrollView horizontal style={{ width: '100%' }}>
        <Text
          style={[typeScale.mono, { color: theme.text }, Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as any) : null]}
          selectable
        >
          {text}
        </Text>
      </ScrollView>
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
          onPress={url ? () => Linking.openURL(assetBrowserUrl(url)).catch(() => {}) : undefined}
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

// "| a | b |" → ['a','b'] (outer pipes optional, cells trimmed).
function splitTableRow(s: string): string[] {
  let t = s.trim();
  if (!t.includes('|')) return [];
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

// GFM table → horizontally-scrollable grid. Column widths estimated from cell
// content (CJK counted double) since RN can't measure text pre-layout; capped so
// one verbose column can't push the rest off-screen — its text wraps instead.
function MdTable({ head, rows, theme }: { head: string[]; rows: string[][]; theme: ReturnType<typeof useTheme> }) {
  const cols = head.length;
  const widths = Array.from({ length: cols }, (_, ci) => {
    let m = 3;
    for (const r of [head, ...rows]) {
      const s = r[ci] ?? '';
      let w = 0;
      for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
      m = Math.max(m, w);
    }
    return Math.min(240, Math.max(56, m * 7 + 22));
  });
  const cell = (textVal: string, ci: number, kp: string, header?: boolean) => (
    <View
      key={ci}
      style={[
        styles.mdTableCell,
        { width: widths[ci], borderColor: theme.border },
        header ? { backgroundColor: theme.surfaceMuted } : null,
        ci === cols - 1 ? { borderRightWidth: 0 } : null,
      ]}
    >
      <Text variant="caption" selectable style={header ? { fontWeight: '700' } : undefined}>
        {renderInline(textVal, theme, kp)}
      </Text>
    </View>
  );
  return (
    <ScrollView horizontal style={{ maxWidth: '100%' }} contentContainerStyle={{ flexDirection: 'column' }}>
      <View style={[styles.mdTable, { borderColor: theme.border }]}>
        <View style={{ flexDirection: 'row' }}>{head.map((c, ci) => cell(c, ci, `th${ci}`, true))}</View>
        {rows.map((r, ri) => (
          <View key={ri} style={[{ flexDirection: 'row' }, ri === rows.length - 1 ? styles.mdTableLastRow : null]}>
            {Array.from({ length: cols }, (_, ci) => cell(r[ci] ?? '', ci, `t${ri}c${ci}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// Block-level markdown for a non-code text segment: headings, bullet / numbered
// lists, blockquotes, horizontal rules, tables, and paragraphs (consecutive
// plain lines kept together). No new deps — react-native-markdown-display
// doesn't play well with RN 0.83 / React 19, so this is a small purpose-built
// renderer.
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
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    // GFM table: a header row + |---| separator + body rows. Agents emit these
    // freely (web renders them via remark-gfm); without this they showed as raw
    // pipe soup. Consumes the whole table block, then continues the line loop.
    if (line.includes('|')) {
      const headCells = splitTableRow(line);
      const sepCells = splitTableRow(lines[li + 1] ?? '');
      const isSep = sepCells.length >= 2 && sepCells.every((c) => /^:?-{3,}:?$/.test(c));
      if (headCells.length >= 2 && isSep) {
        flushPara();
        const rows: string[][] = [];
        let rj = li + 2;
        while (rj < lines.length && lines[rj].includes('|') && lines[rj].trim() !== '') {
          rows.push(splitTableRow(lines[rj]));
          rj += 1;
        }
        blocks.push(<MdTable key={`tb${blocks.length}`} head={headCells} rows={rows} theme={theme} />);
        li = rj - 1;
        continue;
      }
    }
    // Standalone media reference on its own line:
    //   ![name](url)      → inline image thumbnail (tap → full)
    //   [🎬 name](url)     → video card (tap → system player)
    //   [name](/assets/…)  → file card (tap → open)
    const media = /^\s*(!?)\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (media) {
      const isImage = media[1] === '!';
      const label = media[2].replace(/^🎬\s*/, '');
      const url = media[3];
      const isVideo = /\.(mp4|mov|m4v|webm|3gp|mkv)(\?|$)/i.test(url) || media[2].startsWith('🎬');
      // Render as an attachment block when it targets one of our uploaded assets
      // (servable /assets/files/ URL OR an absolute /…/cicy-ai/assets/ host path,
      // which is what a file attachment is now embedded as — agent-readable), or
      // an external image/video. A plain markdown link stays an inline link.
      const asset = isAssetRef(url);
      if (asset || (/^https?:/.test(url) && (isImage || isVideo))) {
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
  const [viewerOpen, setViewerOpen] = useState(false);
  // Real aspect ratio once the thumbnail loads (was a hard 200×200 crop);
  // clamped so extreme panoramas/scrolls don't take over the list.
  const [ratio, setRatio] = useState(0);
  // External open (browser / system viewer) needs the token IN the URL — the
  // browser can't send our Bearer header (see assetBrowserUrl).
  const open = () => Linking.openURL(assetBrowserUrl(url)).catch(() => {});

  if (isImage) {
    return (
      <>
        {/* Tap → in-app lightbox (NOT the browser: cloud assets need the Bearer
            header, which an external browser doesn't have → 401 dead-end). */}
        <PressableScale onPress={() => setViewerOpen(true)} scaleTo={0.98} style={styles.mediaImageWrap}>
          <Image
            source={src as any}
            style={[styles.mediaImage, ratio ? { height: undefined, aspectRatio: ratio } : null]}
            resizeMode="cover"
            onLoad={(e: any) => {
              const s = e?.nativeEvent?.source;
              if (s?.width > 0 && s?.height > 0) setRatio(Math.max(0.6, Math.min(2.2, s.width / s.height)));
            }}
          />
        </PressableScale>
        {viewerOpen ? (
          <ImageLightbox src={src} browserUrl={assetBrowserUrl(url)} name={name} onClose={() => setViewerOpen(false)} />
        ) : null}
      </>
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
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  jumpChip: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    // subtle lift so it reads as floating over the list
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  outcomeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  outcomeRetry: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepsExpander: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
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
    // 240×180 placeholder until onLoad swaps in the real (clamped) aspectRatio —
    // the old hard 200×200 crop mangled every non-square image.
    width: 240,
    height: 180,
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
  diffLine: {
    paddingHorizontal: spacing.xs,
    lineHeight: 18,
  },
  codeBlock: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  loadMoreRow: { alignItems: 'center', paddingTop: 0, paddingBottom: spacing.md },
  mdTable: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  mdTableCell: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mdTableLastRow: { marginBottom: -StyleSheet.hairlineWidth }, // outer border owns the bottom edge
});
