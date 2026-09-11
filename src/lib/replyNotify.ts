// Reply notifications: EVERY prompt sent from the phone gets its own
// notification in the system tray that follows its reply — "正在回复…" the
// moment it is sent, updated in place to "回复完成" (with the first line of the
// answer) or "回复失败". Several prompts may be in flight at once, to one agent
// (cicy-code queues them) or to many; each is matched to its own history
// prompt id (see replyTracker.ts) so the notifications settle independently
// and in order. One poller per agent outlives the chat screen: leaving the
// chat (or the app) does not lose the updates. Each notification carries the
// machine id, the agent id and the agent title; tapping it opens that chat.
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
const POLL_MS = 3000;
const MAX_TRACK_MS = 60 * 60 * 1000; // give up on a prompt after an hour

type Poller = {
  key: string;
  ref: ReplyRef; // agent/machine identity (prompt differs per entry)
  api: ReturnType<typeof createApi>;
  pending: (TrackedPrompt & { ref: ReplyRef })[];
  timer: ReturnType<typeof setTimeout> | null;
  ticking: boolean;
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
            importance: N.AndroidImportance.DEFAULT,
            vibrationPattern: [0, 100],
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

async function present(id: string, ref: ReplyRef, state: 'working' | 'done' | 'failed', detail: string) {
  const N = mod();
  if (!N || !(await ensureNotifications())) return;
  const stateText =
    state === 'working'
      ? i18n.t('notify.working', { defaultValue: 'Replying…' })
      : state === 'done'
      ? i18n.t('notify.done', { defaultValue: 'Reply finished' })
      : i18n.t('notify.failed', { defaultValue: 'Reply failed' });
  const title = `${ref.agentTitle || ref.agentId} · ${stateText}`;
  const body = [detail, `${ref.machineTitle} (${ref.machineId}) · ${ref.agentId}`].filter(Boolean).join('\n');
  try {
    // Same identifier → the tray entry is replaced in place, so one prompt is
    // one notification whose text moves from "replying" to "finished".
    await N.scheduleNotificationAsync({
      identifier: id,
      content: {
        title,
        body,
        data: { machineId: ref.machineId, agentId: ref.agentId, serverUrl: ref.serverUrl, state },
        ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch {
    /* notifications are best-effort */
  }
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
      for (const done of settle(p.pending, ids, reply)) {
        const e = byId.get(done.id);
        if (e) void present(e.id, e.ref, done.state, done.answer || firstLine(e.prompt));
      }
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
 * Start following the reply to one prompt. Posts its "replying" notification
 * at once and polls the agent (history-ids + current-reply) until THAT prompt
 * is answered, then updates the same notification. Prompts to the same agent
 * share one poller but keep separate notifications.
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
    };
    pollers.set(key, p);
  }
  seq += 1;
  const id = `${key}#${Date.now().toString(36)}-${seq}`;
  p.pending.push({ id, prompt: ref.prompt, startedAt: Date.now(), ref });
  void present(id, ref, 'working', firstLine(ref.prompt));
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
