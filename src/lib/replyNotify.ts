// Reply notifications: ONE notification per agent in the system tray that
// follows the replies to the prompts sent from the phone — "正在回复…" the
// moment a prompt is sent, updated in place to "回复完成" (with the first line
// of the answer) or "回复失败" once every prompt sent to that agent has been
// answered. Several prompts may be in flight on one agent (cicy-code queues
// them): they are tracked individually (each matched to its own history prompt
// id, see replyTracker.ts) but rendered as a single entry with a progress
// count ("2/3"). Different agents get different entries. One poller per agent
// outlives the chat screen: leaving the chat (or the app) does not lose the
// updates. Each notification carries the machine id, the agent id and the
// agent title; tapping it opens that chat.
//
// Native only (expo-notifications is a no-op on web). Permission is asked the
// first time a prompt is sent.
import { Platform } from 'react-native';

import { createApi } from '@/src/api/http';
import { useAuthStore } from '@/src/store/auth';
import i18n from '@/src/i18n';

import { firstLine, settle, type TrackedPrompt } from './replyTracker';

export type ReplyRef = {
  serverUrl: string;
  token: string;
  /** hub instance id or the team id — shown to the user as part of the body. */
  machineId: string;
  machineTitle: string;
  agentId: string;
  agentTitle: string;
  /** what was sent (first line is echoed in the notification body) */
  prompt: string;
};

const CHANNEL_ID = 'agent-replies';
// Finished replies land on a second channel that vibrates (Android channels
// own the vibration setting, so "replying" stays silent and "finished" buzzes).
const DONE_CHANNEL_ID = 'agent-replies-done';
const DONE_VIBRATION = [0, 250, 150, 250];
const POLL_MS = 3000;
const MAX_TRACK_MS = 60 * 60 * 1000; // give up on a prompt after an hour

type Poller = {
  key: string;
  ref: ReplyRef; // agent/machine identity (prompt differs per entry)
  api: ReturnType<typeof createApi>;
  pending: (TrackedPrompt & { ref: ReplyRef })[];
  timer: ReturnType<typeof setTimeout> | null;
  ticking: boolean;
  /** Current batch (since the agent was last idle): counts for the "n/m" line. */
  total: number;
  done: number;
  failed: number;
  lastAnswer: string;
};
const pollers = new Map<string, Poller>();
let seq = 0;

let Notifications: typeof import('expo-notifications') | null = null;
function mod() {
  if (Platform.OS === 'web') return null;
  if (Notifications) return Notifications;
  try {
    Notifications = require('expo-notifications');
  } catch {
    Notifications = null;
  }
  return Notifications;
}

let ready: Promise<boolean> | null = null;
/** Channel + permission, once. Resolves false when notifications are unavailable. */
export function ensureNotifications(): Promise<boolean> {
  if (!ready) {
    ready = (async () => {
      const N = mod();
      if (!N) return false;
      try {
        N.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowAlert: true,
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: false,
            shouldSetBadge: false,
          }),
        });
        if (Platform.OS === 'android') {
          await N.setNotificationChannelAsync(CHANNEL_ID, {
            name: i18n.t('notify.channel', { defaultValue: 'Agent replies' }),
            importance: N.AndroidImportance.LOW,
            enableVibrate: false,
            showBadge: false,
          });
          await N.setNotificationChannelAsync(DONE_CHANNEL_ID, {
            name: i18n.t('notify.channelDone', { defaultValue: 'Reply finished' }),
            importance: N.AndroidImportance.HIGH,
            enableVibrate: true,
            vibrationPattern: DONE_VIBRATION,
            showBadge: false,
          });
        }
        const ok = (p: any) => !!p && (p.granted === true || p.status === 'granted');
        if (ok(await N.getPermissionsAsync())) return true;
        return ok(await N.requestPermissionsAsync());
      } catch {
        return false;
      }
    })();
  }
  return ready;
}

function agentKey(ref: { serverUrl: string; agentId: string }) {
  return `${ref.serverUrl.replace(/\/+$/, '')}|${ref.agentId}`;
}

export async function present(id: string, ref: ReplyRef, state: 'working' | 'done' | 'failed', detail: string, progress?: { done: number; total: number }) {
  const N = mod();
  if (!N || !(await ensureNotifications())) return;
  const stateText =
    state === 'working'
      ? i18n.t('notify.working', { defaultValue: 'Replying…' })
      : state === 'done'
      ? i18n.t('notify.done', { defaultValue: 'Reply finished' })
      : i18n.t('notify.failed', { defaultValue: 'Reply failed' });
  // More than one prompt in the batch → "正在回复… 1/3" so the user sees the
  // queue drain inside the single entry.
  const counter = progress && progress.total > 1 ? ` ${progress.done}/${progress.total}` : '';
  const title = `${ref.agentTitle || ref.agentId} · ${stateText}${counter}`;
  const body = [detail, `${ref.machineTitle} (${ref.machineId}) · ${ref.agentId}`].filter(Boolean).join('\n');
  const finished = state !== 'working';
  try {
    // Same identifier (the agent key) → the tray entry is replaced in place,
    // so an agent has one notification whose text moves along with its replies.
    // Android keeps a posted notification on its original channel, so the
    // finished state (vibrating channel) is dismissed + re-posted.
    if (finished && Platform.OS === 'android') await N.dismissNotificationAsync(id).catch(() => {});
    await N.scheduleNotificationAsync({
      identifier: id,
      content: {
        title,
        body,
        data: { machineId: ref.machineId, agentId: ref.agentId, serverUrl: ref.serverUrl, state },
        ...(Platform.OS === 'android'
          ? { channelId: finished ? DONE_CHANNEL_ID : CHANNEL_ID, vibrationPattern: finished ? DONE_VIBRATION : undefined }
          : {}),
      },
      trigger: null,
    });
    // Foreground: the tray update is quiet, so buzz explicitly.
    if (finished) {
      try {
        const H = require('expo-haptics');
        await H.notificationAsync(state === 'done' ? H.NotificationFeedbackType.Success : H.NotificationFeedbackType.Error);
      } catch {}
    }
  } catch {
    /* notifications are best-effort */
  }
}

/** Re-render the agent's single notification from the poller's counters.
 *  Only the "working" state is posted here (instantly on send, before the
 *  node reports the turn); the live text and the finished state come from
 *  agentWatch.ts, which owns the same notification id. */
function render(p: Poller) {
  const latest = p.pending[p.pending.length - 1];
  if (!latest) return;
  void present(p.key, latest.ref, 'working', firstLine(latest.prompt), { done: p.done, total: p.total });
}

/** Phone-sent prompts still unanswered on this agent (for agentWatch: the
 *  n/m counter, and "don't say finished while our queue is not drained"). */
export function sentProgress(serverUrl: string, agentId: string): { pending: number; done: number; total: number } | null {
  const p = pollers.get(agentKey({ serverUrl, agentId }));
  if (!p) return null;
  return { pending: p.pending.length, done: p.done, total: p.total };
}

function stopPoller(p: Poller) {
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  if (pollers.get(p.key) === p) pollers.delete(p.key);
}

async function tick(p: Poller) {
  if (pollers.get(p.key) !== p || p.ticking) return;
  p.ticking = true;
  try {
    // Prompts we have followed for too long are dropped silently.
    const now = Date.now();
    for (const e of [...p.pending]) {
      if (now - e.startedAt > MAX_TRACK_MS) p.pending.splice(p.pending.indexOf(e), 1);
    }
    if (!p.pending.length) {
      stopPoller(p);
      return;
    }
    const [ids, reply] = await Promise.all([
      p.api.getHistoryIds(p.ref.agentId).catch(() => null),
      p.api.getCurrentReply(p.ref.agentId).catch(() => null),
    ]);
    if (ids || reply) {
      const byId = new Map(p.pending.map((e) => [e.id, e] as const));
      let changed = false;
      for (const done of settle(p.pending, ids, reply)) {
        const e = byId.get(done.id);
        p.done += 1;
        if (done.state === 'failed') p.failed += 1;
        p.lastAnswer = done.answer || (e ? firstLine(e.prompt) : '');
        changed = true;
      }
      if (changed) render(p);
    }
  } finally {
    p.ticking = false;
    if (pollers.get(p.key) === p) {
      if (p.pending.length) p.timer = setTimeout(() => void tick(p), POLL_MS);
      else stopPoller(p);
    }
  }
}

/**
 * Start following the reply to one prompt. Updates the agent's notification
 * to "replying" at once and polls the agent (history-ids + current-reply)
 * until THAT prompt is answered. Prompts to the same agent share one poller
 * AND one notification (with an n/m counter while several are in flight).
 */
export function trackReply(ref: ReplyRef): void {
  if (Platform.OS === 'web') return;
  const key = agentKey(ref);
  let p = pollers.get(key);
  if (!p) {
    p = {
      key,
      ref,
      api: createApi({ serverUrl: ref.serverUrl, token: ref.token }),
      pending: [],
      timer: null,
      ticking: false,
      total: 0,
      done: 0,
      failed: 0,
      lastAnswer: '',
    };
    pollers.set(key, p);
  }
  // A new prompt after the agent went idle starts a fresh batch (fresh "n/m").
  if (!p.pending.length) {
    p.total = 0;
    p.done = 0;
    p.failed = 0;
    p.lastAnswer = '';
  }
  seq += 1;
  const id = `${key}#${Date.now().toString(36)}-${seq}`;
  p.pending.push({ id, prompt: ref.prompt, startedAt: Date.now(), ref });
  p.total += 1;
  render(p);
  if (!p.timer && !p.ticking) p.timer = setTimeout(() => void tick(p!), POLL_MS);
}

/** Chat screen hint: the WS said a reply for this agent just ended — poll now
 *  instead of waiting for the next tick (which prompt finished is decided by
 *  the history ids, never assumed). */
export function markReplyDone(serverUrl: string, agentId: string): void {
  const p = pollers.get(agentKey({ serverUrl, agentId }));
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  void tick(p);
}

/** Notification tap → open that chat. Returns the unsubscribe. */
export function onNotificationOpen(cb: (data: { machineId: string; agentId: string; serverUrl: string }) => void): () => void {
  const N = mod();
  if (!N) return () => {};
  const sub = N.addNotificationResponseReceivedListener((resp) => {
    const d: any = resp?.notification?.request?.content?.data || {};
    if (d?.agentId) cb({ machineId: String(d.machineId || ''), agentId: String(d.agentId), serverUrl: String(d.serverUrl || '') });
  });
  // A tap that launched the app arrives via the last response, not the listener.
  N.getLastNotificationResponseAsync?.().then((resp) => {
    const d: any = resp?.notification?.request?.content?.data || {};
    if (d?.agentId) cb({ machineId: String(d.machineId || ''), agentId: String(d.agentId), serverUrl: String(d.serverUrl || '') });
  }).catch(() => {});
  return () => sub.remove();
}

/** Build a ReplyRef for the current team + an agent. */
export function replyRefFor(agentId: string, agentTitle: string, prompt: string): ReplyRef | null {
  const st = useAuthStore.getState();
  const team = st.teams.find((t) => t.id === st.currentTeamId);
  if (!team) return null;
  return {
    serverUrl: team.serverUrl,
    token: team.token,
    machineId: team.instanceId ? team.instanceId.replace(/^code-/, '').slice(0, 12) : team.id,
    machineTitle: team.title,
    agentId,
    agentTitle,
    prompt,
  };
}
