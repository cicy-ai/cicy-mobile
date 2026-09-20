// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Fleet watcher: EVERY working agent on every reachable machine gets a live
// notification — not only the prompts sent from this phone. One entry per
// agent (id = server|agent, shared with replyNotify.ts): title "<agent> ·
// 正在回复…", body = what the agent is doing RIGHT NOW (the tail of the text
// it is writing, or the tool it is running), refreshed every few seconds;
// when the agent stops, the same entry becomes "回复完成" (vibrates) with the
// first line of the answer.
//
// Data source: one /api/agents/current-reply-batch per machine per tick (the
// roster's lite metrics: status, latest_response, latest_tool) — no per-agent
// fan-out. Pane titles come from /api/panes, refreshed once a minute.
//
// Limits: this runs inside the app process. Foreground: 3s ticks. Background:
// slower ticks, and Android suspends JS timers a few minutes after the app
// leaves the screen, so a reply that ends while the app has been backgrounded
// for long is reported on the next foreground. Push from the hub would be
// needed for anything beyond that.
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { createApi } from '@/src/api/http';
import { useAuthStore, type Team } from '@/src/store/auth';

import { firstLine, liveBody } from './replyTracker';
import { present, sentProgress, type ReplyRef } from './replyNotify';

const TICK_FG_MS = 3000;
const TICK_BG_MS = 8000;
const ROSTER_MS = 60_000;
const TERMINAL = new Set(['completed', 'complete', 'done', 'idle', 'aborted', 'error', 'canceled', 'cancelled', 'failed', 'stopped']);
const FAILED = new Set(['aborted', 'error', 'canceled', 'cancelled', 'failed', 'stopped']);

type Roster = { at: number; agents: { id: string; title: string }[] };
type Live = { working: boolean; body: string; failed: boolean; question: string; answer: string };

const rosters = new Map<string, Roster>(); // team id → roster
const live = new Map<string, Live>(); // server|agent → last state
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let ticking = false;
let appState: AppStateStatus = AppState.currentState;

function key(serverUrl: string, agentId: string) {
  return `${serverUrl.replace(/\/+$/, '')}|${agentId}`;
}

function refFor(team: Team, agentId: string, title: string, prompt: string): ReplyRef {
  return {
    serverUrl: team.serverUrl,
    token: team.token,
    machineId: team.instanceId ? team.instanceId.replace(/^code-/, '').slice(0, 12) : team.id,
    machineTitle: team.title,
    agentId,
    agentTitle: title,
    prompt,
  };
}

async function roster(team: Team): Promise<{ id: string; title: string }[]> {
  const cached = rosters.get(team.id);
  if (cached && Date.now() - cached.at < ROSTER_MS) return cached.agents;
  const api = createApi({ serverUrl: team.serverUrl, token: team.token });
  try {
    const panes = await api.getPanes();
    const seen = new Set<string>();
    const agents: { id: string; title: string }[] = [];
    for (const p of panes) {
      if (typeof p.pane_id !== 'string' || !p.pane_id) continue;
      const id = p.pane_id.split(':')[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      agents.push({ id, title: p.title || id });
    }
    rosters.set(team.id, { at: Date.now(), agents });
    return agents;
  } catch {
    return cached?.agents ?? [];
  }
}

async function watchTeam(team: Team) {
  const agents = await roster(team);
  if (!agents.length) return;
  const api = createApi({ serverUrl: team.serverUrl, token: team.token });
  const res = await api.getCurrentReplyBatch(agents.map((a) => a.id)).catch(() => null);
  const metrics = res?.metrics || {};
  for (const a of agents) {
    const m = metrics[a.id];
    if (!m) continue;
    const st = String(m.status || '').trim().toLowerCase();
    const working = m.complete !== true && st !== '' && !TERMINAL.has(st);
    const k = key(team.serverUrl, a.id);
    const prev = live.get(k);
    const question = String(m.latest_question || '');
    const answer = String(m.latest_response_type || 'text') === 'text' ? String(m.latest_response || '') : '';
    const sent = sentProgress(team.serverUrl, a.id);
    const progress = sent && sent.total > 0 ? { done: sent.done, total: sent.total } : undefined;
    if (working) {
      const body = liveBody(m) || firstLine(question);
      if (!prev || !prev.working || prev.body !== body) {
        void present(k, refFor(team, a.id, a.title, question), 'working', body, progress);
      }
      live.set(k, { working: true, body, failed: false, question, answer });
      continue;
    }
    // Idle. Only agents we saw working get the "finished" update; an agent
    // that was already idle when the watcher started is left alone.
    if (prev?.working) {
      // Phone-sent prompts still queued on this agent: the node goes idle for
      // a moment between queued turns — don't announce "finished" yet.
      if (sent && sent.pending > 0) continue;
      const failed = FAILED.has(st);
      void present(k, refFor(team, a.id, a.title, question), failed ? 'failed' : 'done', firstLine(answer, 100) || firstLine(question), progress);
    }
    live.set(k, { working: false, body: '', failed: FAILED.has(st), question, answer });
  }
}

async function tick() {
  if (!running || ticking) return;
  ticking = true;
  try {
    const st = useAuthStore.getState();
    if (!st.session) return;
    const teams = st.teams.filter((t) => t.kind === 'hub' && t.online !== false && !!t.token);
    await Promise.all(teams.map((t) => watchTeam(t).catch(() => {})));
  } finally {
    ticking = false;
    if (running) timer = setTimeout(() => void tick(), appState === 'active' ? TICK_FG_MS : TICK_BG_MS);
  }
}

/** Start watching (idempotent). Returns the stop function. */
export function startAgentWatch(): () => void {
  if (Platform.OS === 'web' || running) return stopAgentWatch;
  running = true;
  const sub = AppState.addEventListener('change', (s) => {
    const was = appState;
    appState = s;
    // Back to the foreground → poll at once instead of waiting a slow tick.
    if (s === 'active' && was !== 'active' && running && !ticking) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void tick(), 0);
    }
  });
  timer = setTimeout(() => void tick(), 1000);
  const off = () => {
    sub.remove();
    stopAgentWatch();
  };
  return off;
}

export function stopAgentWatch(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
