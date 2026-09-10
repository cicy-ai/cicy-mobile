// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Reply notifications: every prompt sent from the phone gets ONE notification
// in the system tray that follows the reply — "正在回复…" the moment it is
// sent, updated in place to "回复完成" (with the first line of the answer) or
// "回复失败". The tracker outlives the chat screen: it polls the agent's
// current-reply until a terminal state, so leaving the chat (or the app) does
// not lose the update. Each notification carries the machine id, the agent id
// and the agent title; tapping it opens that chat.
//
// Native only (expo-notifications is a no-op on web). Permission is asked the
// first time a prompt is sent.
import { Platform } from 'react-native';

import { createApi } from '@/src/api/http';
import { useAuthStore } from '@/src/store/auth';
import i18n from '@/src/i18n';

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
const MAX_TRACK_MS = 60 * 60 * 1000; // give up after an hour
const TERMINAL = new Set(['completed', 'done', 'idle', 'failed', 'error', 'cancelled', 'canceled', 'blocked', 'timeout']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'blocked', 'timeout']);

type Tracker = { key: string; timer: ReturnType<typeof setTimeout> | null; startedAt: number; ref: ReplyRef; lastId: number };
const trackers = new Map<string, Tracker>();

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

function trackKey(ref: ReplyRef) {
  return `${ref.serverUrl.replace(/\/+$/, '')}|${ref.agentId}`;
}

function firstLine(s: string, max = 80): string {
  const line = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

async function present(ref: ReplyRef, state: 'working' | 'done' | 'failed', detail: string) {
  const N = mod();
  if (!N || !(await ensureNotifications())) return;
  const key = trackKey(ref);
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
      identifier: key,
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

function stop(key: string) {
  const t = trackers.get(key);
  if (t?.timer) clearTimeout(t.timer);
  trackers.delete(key);
}

/**
 * Start following a reply for `ref`. Posts the "replying" notification at once
 * and polls /api/agents/current-reply until the reply reaches a terminal
 * state, then updates the same notification. A second prompt to the same
 * agent restarts the tracker (one notification per agent at a time).
 */
export function trackReply(ref: ReplyRef): void {
  if (Platform.OS === 'web') return;
  const key = trackKey(ref);
  stop(key);
  const tracker: Tracker = { key, timer: null, startedAt: Date.now(), ref, lastId: 0 };
  trackers.set(key, tracker);
  void present(ref, 'working', firstLine(ref.prompt));
  const api = createApi({ serverUrl: ref.serverUrl, token: ref.token });
  const tick = async () => {
    if (trackers.get(key) !== tracker) return;
    if (Date.now() - tracker.startedAt > MAX_TRACK_MS) {
      stop(key);
      return;
    }
    try {
      const r: any = await api.getCurrentReply(ref.agentId);
      const status = String(r?.status || '').toLowerCase();
      const complete = r?.complete === true || TERMINAL.has(status);
      // The reply we are following is the one that started after our send:
      // ignore a stale completed snapshot from the previous turn (history_id
      // not advanced yet, question different from ours) for the first ticks.
      const question = String(r?.question || '').trim();
      const ours = !question || question.includes(firstLine(ref.prompt, 40)) || Date.now() - tracker.startedAt > 20_000;
      if (complete && ours) {
        const failed = FAILED.has(status);
        const answer = firstLine(String(r?.answer || ''), 100);
        await present(ref, failed ? 'failed' : 'done', answer || firstLine(ref.prompt));
        stop(key);
        return;
      }
    } catch {
      /* transient — keep polling */
    }
    if (trackers.get(key) === tracker) tracker.timer = setTimeout(tick, POLL_MS);
  };
  tracker.timer = setTimeout(tick, POLL_MS);
}

/** Chat screen shortcut: the WS already told us the reply ended. */
export function markReplyDone(serverUrl: string, agentId: string, detail?: string): void {
  const key = `${serverUrl.replace(/\/+$/, '')}|${agentId}`;
  const t = trackers.get(key);
  if (!t) return;
  stop(key);
  void present(t.ref, 'done', detail || firstLine(t.ref.prompt));
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
