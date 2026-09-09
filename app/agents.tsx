// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  FlatList,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/src/components/Button';
import { ConfirmModal } from '@/src/components/ConfirmModal';
import { AgentAvatar } from '@/src/components/AgentAvatar';
import { AgentStatusDot } from '@/src/components/AgentStatusDot';
import { CtxRing } from '@/src/components/CtxRing';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TeamDrawer } from '@/src/components/TeamDrawer';
import { TeamTitleModal } from '@/src/components/TeamTitleModal';
import { Text } from '@/src/components/Text';
import { api } from '@/src/api/http';
import { ChatWsClient } from '@/src/api/chatws';
import { checkApkUpdate, type ApkUpdate } from '@/src/lib/appUpdate';
import { useOtaReady } from '@/src/lib/otaInfo';
import type { Agent, ProjectGroup } from '@/src/api/types';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import {
  fmtCost,
  metricsFromCurrentReply,
  modelColor,
  modelShort,
  type AgentLiveMetrics,
} from '@/src/lib/agentMetrics';
import { normalizeAgentType } from '@/src/lib/agentType';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

// Member types offered on self-hosted teams (per user: cicy/claude/codex/
// opencode). Cloud default teams are server-locked to 'cicy' (w-10122) —
// the picker collapses to a notice there.
const CREATE_TYPES = ['cicy', 'claude', 'codex', 'opencode'] as const;

// We only show the team's master/dispatcher pane and its direct workers. The
// backend returns every agent regardless of host, so we filter client-side.
// cicy-code stamps each worker's master into its pane_id (all of a team's
// workers share it), so the master is derived from /api/poll per load rather
// than hardcoded — teams differ. Falls back to this default when a team has no
// workers yet to derive from.
const DEFAULT_MASTER = 'w-1001';
// Background-aware refresh cadence. 5s feels live without hammering the API.
const POLL_INTERVAL_MS = 5000;

// Live per-agent metrics (model / context / cost) — DUAL CHANNEL, push-first,
// the exact port of cicy-code TeamPanel's useTeamLiveMetrics:
//   PRIMARY  — the chat WS poll_data push: `pushed` is the statuses map off the
//              broadcast; the server packs full header metrics into each entry,
//              so one push updates the whole team with ZERO requests.
//   FALLBACK — only when the WS is down OR its push has gone stale, a SINGLE
//              batched /current-reply-batch call (never N× /current-reply).
// sig-compare keeps unchanged agents referentially stable so rows don't churn.
const TEAM_METRICS_PUSH_STALE_MS = 12000; // push older than this ⇒ allow a fallback poll
const TEAM_METRICS_FALLBACK_MS = 5000; // fallback batch-poll cadence (1 request)

function useTeamLiveMetrics(
  ids: string[],
  active: boolean,
  pushed: Record<string, any>,
  wsConnected: boolean,
): Record<string, AgentLiveMetrics> {
  const [metrics, setMetrics] = useState<Record<string, AgentLiveMetrics>>({});
  const key = ids.join(',');
  const lastPushRef = useRef(0);

  const fold = useCallback((lookup: (wid: string) => any) => {
    setMetrics((prev) => {
      let changed = false;
      const next: Record<string, AgentLiveMetrics> = { ...prev };
      for (const wid of key.split(',').filter(Boolean)) {
        const d = lookup(wid);
        if (!d) continue; // no reply snapshot yet → keep last-known
        const m = metricsFromCurrentReply(d, prev[wid]);
        if (prev[wid]?.sig !== m.sig || prev[wid]?.model !== m.model) { next[wid] = m; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [key]);

  // PRIMARY: fold the WS-pushed statuses whenever they change. Keys arrive as
  // full pane ids (`<wid>:main.0`) — tolerate either form.
  useEffect(() => {
    if (!pushed || !key || !Object.keys(pushed).length) return;
    fold((wid) => pushed[`${wid}:main.0`] || pushed[wid]);
    lastPushRef.current = Date.now();
  }, [pushed, key, fold]);

  // FALLBACK: ONE batched request, ONLY while on-screen AND the push channel is
  // down/stale. WS alive & fresh → zero polling.
  useEffect(() => {
    if (!key || !active) return;
    let cancelled = false;
    const tick = async () => {
      const stale = Date.now() - lastPushRef.current > TEAM_METRICS_PUSH_STALE_MS;
      if (wsConnected && !stale) return;
      const res = await api.getCurrentReplyBatch(key.split(',').filter(Boolean)).catch(() => null);
      if (cancelled || !res?.metrics) return;
      const m = res.metrics;
      fold((wid) => m[wid]);
    };
    tick(); // immediate seed when the push channel is cold at mount
    const t = setInterval(tick, TEAM_METRICS_FALLBACK_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key, active, wsConnected, fold]);
  return metrics;
}

export default function Agents() {
  const { t } = useTranslation();
  const theme = useTheme();
  const teams = useAuthStore((s) => s.teams);
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const currentTeam = teams.find((tm) => tm.id === currentTeamId) ?? null;
  const session = useAuthStore((s) => s.session);
  // Hub machines show EVERY agent on the node, grouped by project; QR-scanned
  // customs keep the one-master-and-its-workers view.
  const hubMode = currentTeam?.kind === 'hub';
  const [projects, setProjects] = useState<ProjectGroup[]>([]);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [titleModalOpen, setTitleModalOpen] = useState(false);
  const [gatewayByName, setGatewayByName] = useState<Record<string, boolean>>({});
  // Team master pane id (derived per load) — needed as master_pane_id when
  // creating a worker, and to shield the master row from swipe-delete.
  const [hostPaneId, setHostPaneId] = useState<string | null>(null);
  // create-member dialog + swipe-delete confirm state.
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<string>('cicy');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  // TeamPanel-parity member management: long-press action sheet + fork/unbind
  // confirms + the ⊕ add menu (create new vs bind an existing unbound pane).
  const [memberMenu, setMemberMenu] = useState<Agent | null>(null);
  const [confirmFork, setConfirmFork] = useState<Agent | null>(null);
  const [confirmUnbind, setConfirmUnbind] = useState<Agent | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [bindCandidates, setBindCandidates] = useState<{ wid: string; title: string; agentType: string }[] | null>(null);
  const [bindBusy, setBindBusy] = useState(false);
  // Member types are free on every node reachable today (the cloud-locked
  // 'cicy'-only tenant is retired).
  const cloudLocked = false;
  // Sideload self-update: newer APK on the CDN → banner (Android only).
  const ota = useOtaReady();
  const [apkUpdate, setApkUpdate] = useState<ApkUpdate | null>(null);
  useEffect(() => {
    let alive = true;
    checkApkUpdate().then((u) => { if (alive && u) setApkUpdate(u); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Only poll while this screen is the focused route — navigating into a chat
  // pauses ALL roster/metric requests (they resume on return).
  const isFocused = useIsFocused();
  const agentId = useCallback((a: Agent) => String(a.name || a.id || a.pane_id || ''), []);
  const agentIds = useMemo(() => agents.map(agentId).filter(Boolean), [agents, agentId]);

  // ── Team WS (push-first roster + metrics) ─────────────────────────────────
  // One socket registered on the team's master: the server broadcasts poll_data
  // every 5s (roster + full header metrics in one frame), so the steady state is
  // ZERO HTTP requests. HTTP (load()/batch) remains only as seed + fallback.
  const { serverUrl, token, clientId } = useAuthStore();
  const [pushedStatuses, setPushedStatuses] = useState<Record<string, any>>({});
  const [wsUp, setWsUp] = useState(false);
  const lastPollPushRef = useRef(0);
  // Self-host roster recompose needs the latest panes snapshot (masters /
  // workspace / gateway flags) without refetching — load() keeps it fresh.
  const panesRef = useRef<any[] | null>(null);
  const composeFromWorkersRef = useRef<((workerRows: any[]) => void) | null>(null);

  useEffect(() => {
    if (!currentTeam || !isFocused || !hostPaneId || !serverUrl || !token) return;
    const ws = new ChatWsClient({ serverUrl, token, clientId, agentId: hostPaneId });
    const offMsg = ws.on((msg: any) => {
      if (msg?.type !== 'poll_data' || !msg.data) return;
      lastPollPushRef.current = Date.now();
      const statuses = msg.data.statuses;
      if (statuses && typeof statuses === 'object') setPushedStatuses(statuses);
      // Roster rides the same frame (self-host teams; cloud tenants keep their
      // panes-derived roster — poll_data carries no rows for configOnly roles).
      const rows = Array.isArray(msg.data.agents) ? msg.data.agents : [];
      if (rows.length) composeFromWorkersRef.current?.(rows);
    });
    const offStatus = ws.onStatus((s) => {
      setWsUp(s === 'open');
      if (s === 'open') ws.send({ type: 'poll_request', data: {} } as any); // instant seed
    });
    ws.connect();
    // Cadence: ONE tiny WS frame every 5s asks the server for a fresh poll_data
    // (mirrors Workspace's sendPollRequest interval). Server replies on the same
    // socket → roster + all metrics with zero HTTP requests.
    const pollTimer = setInterval(() => {
      ws.send({ type: 'poll_request', data: {} } as any);
    }, 5000);
    return () => {
      clearInterval(pollTimer);
      offMsg();
      offStatus();
      ws.close();
      setWsUp(false);
    };
  }, [currentTeam?.id, isFocused, hostPaneId, serverUrl, token, clientId]);

  const liveMetrics = useTeamLiveMetrics(agentIds, isFocused, pushedStatuses, wsUp);

  // ── Fork tree + machine groups (port of TeamPanel's forksByParent/nestedWids,
  // incl. the cycle guard) ────────────────────────────────────────────────────
  // /api/poll rows carry source_kind/source_ref/machine_label and mobile's
  // compose spreads them onto each Agent, so the same shape web renders is
  // derivable here: fork children nest under their parent (collapsible), and
  // when workers span machines a slim group label separates them.
  const [collapsedWids, setCollapsedWids] = useState<Set<string>>(new Set());
  const toggleCollapsed = useCallback((wid: string) => {
    setCollapsedWids((prev) => {
      const next = new Set(prev);
      if (next.has(wid)) next.delete(wid);
      else next.add(wid);
      return next;
    });
  }, []);

  type ListRow =
    | { kind: 'agent'; agent: Agent; depth: number; forkCount: number; collapsed: boolean }
    | { kind: 'machine'; key: string; label: string }
    | { kind: 'project'; key: string; label: string; count: number; slug?: string };
  const listRows = useMemo<ListRow[]>(() => {
    const wid = (a: Agent) => String(a.name ?? a.id ?? a.pane_id ?? '');
    const master = hubMode ? null : (agents.find((a) => wid(a) === hostPaneId) ?? null);
    const workers = agents.filter((a) => a !== master);
    const byWid = new Map(workers.map((a) => [wid(a), a] as const));
    const isFork = (a: Agent) => String((a as any).source_kind || '') === 'fork' && !!(a as any).source_ref;
    // Project membership first (hub machines): a fork only nests under its
    // parent when both live in the SAME project — otherwise a fork that was
    // moved to another project would be drawn (and counted) under the wrong
    // section, pulling its own subtree along with it.
    const sectionOf = new Map<string, string>();
    if (hubMode && projects.length > 0) {
      for (const g of projects) {
        const ids = new Set((g.pane_ids || []).map((p) => String(p).split(':')[0]));
        for (const a of workers) if (ids.has(wid(a)) && !sectionOf.has(wid(a))) sectionOf.set(wid(a), `p:${g.id}`);
      }
    }
    const byParent = new Map<string, Agent[]>();
    const nested = new Set<string>();
    for (const a of workers) {
      if (!isFork(a)) continue;
      const parentWid = String((a as any).source_ref || '').split(':')[0];
      if (!parentWid || !byWid.has(parentWid) || parentWid === wid(a)) continue;
      if (sectionOf.size && sectionOf.get(parentWid) !== sectionOf.get(wid(a))) continue;
      if (!byParent.has(parentWid)) byParent.set(parentWid, []);
      byParent.get(parentWid)!.push(a);
      nested.add(wid(a));
    }
    // Cycle guard (web-identical): an edge that would make a node an ancestor
    // of its own parent chain loops the recursion — drop it back to top level.
    const reaches = (from: string, target: string, depth = 0): boolean => {
      if (depth > 16) return false;
      return (byParent.get(from) || []).some((k) => wid(k) === target || reaches(wid(k), target, depth + 1));
    };
    for (const [parentWid, kids] of [...byParent.entries()]) {
      const safe = kids.filter((k) => !reaches(wid(k), parentWid));
      for (const k of kids) if (!safe.includes(k)) nested.delete(wid(k));
      if (safe.length) byParent.set(parentWid, safe);
      else byParent.delete(parentWid);
    }
    const subtreeCount = (w: string, depth = 0): number => {
      if (depth > 16) return 0;
      return (byParent.get(w) || []).reduce((n, k) => n + 1 + subtreeCount(wid(k), depth + 1), 0);
    };
    const rows: ListRow[] = [];
    const pushTree = (a: Agent, depth: number) => {
      const w = wid(a);
      const forkCount = subtreeCount(w);
      const collapsed = collapsedWids.has(w);
      rows.push({ kind: 'agent', agent: a, depth, forkCount, collapsed });
      if (!collapsed) for (const kid of byParent.get(w) || []) pushTree(kid, depth + 1);
    };
    const topLevel = workers.filter((a) => !nested.has(wid(a)));
    if (hubMode && (projects.length > 0 || master)) {
      // Project sections: each project lists the agents whose pane belongs to
      // it (masters included — on a hub machine they are ordinary members of
      // their project); whatever is in no project goes under "Ungrouped".
      const everyone = master ? [master, ...topLevel] : topLevel;
      const placed = new Set<string>();
      const sections: { key: string; label: string; slug?: string; members: Agent[] }[] = [];
      for (const g of projects) {
        const ids = new Set((g.pane_ids || []).map((p) => String(p).split(':')[0]));
        const members = everyone.filter((a) => ids.has(wid(a)) && !placed.has(wid(a)));
        for (const m of members) placed.add(wid(m));
        if (!members.length && !g.is_default) continue; // hide empty projects
        sections.push({ key: `p:${g.id}`, label: g.name || String(g.project_template || g.id), slug: g.project_template, members });
      }
      const rest = everyone.filter((a) => !placed.has(wid(a)));
      if (rest.length) sections.push({ key: 'p:ungrouped', label: t('agents.projectUngrouped'), members: rest });
      for (const sec of sections) {
        const count = sec.members.reduce((n, a) => n + 1 + subtreeCount(wid(a)), 0);
        rows.push({ kind: 'project', key: sec.key, label: sec.label, count, slug: sec.slug });
        for (const a of sec.members) pushTree(a, 0);
      }
      return rows;
    }
    if (master) rows.push({ kind: 'agent', agent: master, depth: 0, forkCount: 0, collapsed: false });
    const groups = new Map<string, Agent[]>();
    for (const a of topLevel) {
      const label = String((a as any).machine_label || '').trim() || t('agents.localMachine');
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(a);
    }
    const multiMachine = groups.size > 1;
    for (const [label, members] of groups) {
      if (multiMachine) rows.push({ kind: 'machine', key: `m:${label}`, label });
      for (const a of members) pushTree(a, 0);
    }
    return rows;
  }, [agents, hostPaneId, collapsedWids, t, hubMode, projects]);

  const load = useCallback(async () => {
    if (!currentTeam) {
      setAgents([]);
      setError(null);
      return;
    }
    // NB: don't clear the error here. A background poll (every 5s) that clears
    // the error up-front, then re-sets it when the request fails again, makes
    // the error screen flash to empty and back every tick on a persistently-
    // failing team (e.g. 502). Clear the error only once a fetch SUCCEEDS.
    try {
      if (hubMode) {
        // Hub machine: the whole node. EVERY pane is an agent (masters and
        // workers alike — on some nodes /api/poll returns nothing at all and
        // no pane carries role=master, so the roster must come from
        // /api/panes); /api/poll rows and the WS poll_data pushes only overlay
        // live fields (status, source_kind/source_ref, machine_label). The
        // project list sections the roster.
        const [poll, panes, groups] = await Promise.all([
          api.poll().catch(() => ({ agents: [] }) as any),
          api.getPanes(),
          api.getProjects().catch(() => [] as ProjectGroup[]),
        ]);
        const validPanes = panes.filter((p) => typeof p.pane_id === 'string' && p.pane_id);
        const masterPanes = validPanes.filter((p) => p.role === 'master');
        const workerRows: any[] = poll.agents ?? [];
        // One socket is registered on a master for the push channel; any will do.
        const firstMaster = masterPanes[0]?.pane_id.split(':')[0] ?? workerRows[0]?.pane_id ?? null;
        setHostPaneId(firstMaster ?? validPanes[0]?.pane_id.split(':')[0] ?? DEFAULT_MASTER);
        const gwByName: Record<string, boolean> = {};
        const base = new Map<string, Agent>();
        for (const p of validPanes) {
          const short = p.pane_id.split(':')[0];
          if (!short || base.has(short)) continue;
          gwByName[short] = !!p.use_custom_gateway;
          base.set(short, {
            name: short,
            pane_id: short,
            agent_type: p.agent_type,
            title: p.title || short,
            status: 'active',
            workspace: p.workspace,
            role: p.role,
          } as Agent);
        }
        setGatewayByName(gwByName);
        // Live overlay by wid; a poll_data push (which carries only the
        // registered master's workers) merges INTO this map so nothing drops.
        const live = new Map<string, any>();
        const fold = (rows: any[]) => {
          for (const a of rows) {
            const w = String(a?.name || '');
            if (w) live.set(w, a);
          }
        };
        const compose = (rows: any[]) => {
          fold(rows);
          const out: Agent[] = [];
          for (const [w, b] of base) {
            const l = live.get(w);
            out.push(l ? { ...l, ...b, title: b.title || l.title, status: l.status || b.status, workspace: b.workspace ?? l.workspace } : b);
          }
          // Panes the node knows only via poll (bound elsewhere) still show.
          for (const [w, l] of live) if (!base.has(w)) out.push({ ...l, workspace: l.workspace });
          setAgents(out);
        };
        composeFromWorkersRef.current = compose;
        panesRef.current = panes;
        setProjects(groups);
        compose(workerRows);
        setError(null);
        return;
      }
      setProjects([]);

      // Self-host teams — cicy-code web's pipeline with ONE mobile-only extra:
      //   · SEED: poll+panes ONCE on entry. /api/poll is unavoidable here — the
      //     panes list can carry SEVERAL role=master rows (every locally created
      //     master pane), and only the worker rows' pane_id says which master
      //     this team actually centres on. web sidesteps this because its URL /
      //     selection already names the pane; mobile has no such context.
      //   · STEADY STATE: workers + statuses ride the WS poll_data frames, zero
      //     HTTP (web-identical). This loader re-runs only as the WS-stale
      //     fallback (web just lets the roster freeze; mobile networks are too
      //     flaky for that).
      const [poll, panes] = await Promise.all([api.poll(), api.getPanes()]);

      // The master this team centres on: every worker row from /api/poll
      // carries it in `pane_id` (e.g. "w-1001"). DEFAULT_MASTER when empty.
      const workerRows = poll.agents ?? [];
      const hostPane =
        workerRows.find((a) => typeof a.pane_id === 'string' && a.pane_id)?.pane_id ||
        DEFAULT_MASTER;
      setHostPaneId(hostPane);

      const masters: Agent[] = panes
        .filter(
          (p) =>
            p.role === 'master' &&
            typeof p.pane_id === 'string' &&
            p.pane_id.startsWith(`${hostPane}:`),
        )
        .map((p) => ({
          name: hostPane,
          pane_id: hostPane,
          agent_type: p.agent_type,
          title: p.title || hostPane,
          status: 'active',
          workspace: p.workspace,
        }));

      // Lookups from /api/panes, keyed by the worker name ("w-10036") = prefix
      // of pane_id ("w-10036:main.0"): workspace per worker, and the gateway
      // flag (solid dot = local AI gateway, hollow = official login direct).
      const workspaceByName = new Map<string, string>();
      const gwByName: Record<string, boolean> = {};
      for (const p of panes) {
        if (typeof p.pane_id !== 'string') continue;
        const key = p.pane_id.split(':')[0];
        if (!key) continue;
        if (p.workspace) workspaceByName.set(key, p.workspace);
        gwByName[key] = !!p.use_custom_gateway;
      }
      setGatewayByName(gwByName);

      // Shared composer: build [masters, ...workers] from a worker-row list.
      // Fed by every WS poll_data frame (primary) and by the HTTP fallback.
      panesRef.current = panes;
      const compose = (rows: any[]) => {
        const workers = rows
          .filter((a) => a.pane_id === hostPane)
          .map((a) => ({
            ...a,
            workspace: a.name ? workspaceByName.get(a.name) : undefined,
          }));
        setAgents([...masters, ...workers]);
      };
      composeFromWorkersRef.current = compose;
      compose(workerRows);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [currentTeam, hubMode]);

  // Team switched → wipe the previous team's list immediately. Without this
  // the old agents (and any stale error) linger until the new fetch lands —
  // or forever, if the new team's server errors out.
  useEffect(() => {
    setAgents([]);
    setProjects([]);
    setError(null);
  }, [currentTeamId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load();
      if (!cancelled) setLoading(false);
      // First data is in (or errored) — hand off from the boot splash straight
      // to real content, no spinner relay.
      dismissBootSplash();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Poll every POLL_INTERVAL_MS while the agents screen is mounted AND the app
  // is foregrounded. We pause on background to avoid burning battery / data
  // when the user has the app off-screen, then immediately refresh on return.
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    // Gate on BOTH focus (this route on-screen) and foreground. Leaving the
    // list for a chat, or backgrounding the app, stops the roster poll entirely.
    if (!currentTeam || !isFocused) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
        // WS poll_data is fresh → the push channel is driving roster+metrics,
        // skip the HTTP tick entirely (steady state: zero requests).
        if (Date.now() - lastPollPushRef.current < TEAM_METRICS_PUSH_STALE_MS) return;
        // Don't show the spinner — silent background refresh.
        load();
      }, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    if (appStateRef.current === 'active') start();

    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (next === 'active' && prev !== 'active') {
        // App resumed — refresh once immediately, then resume the interval.
        load();
        start();
      } else if (next !== 'active') {
        stop();
      }
    });

    return () => {
      stop();
      sub.remove();
    };
  }, [currentTeam, load, isFocused]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Update banner: tap → browser downloads the APK from our CDN → system
  // installer. One tap replaces the whole USB/adb loop.
  const renderUpdateBanner = () =>
    ota.ready ? (
      <PressableScale
        onPress={ota.apply}
        haptic
        scaleTo={0.98}
        style={[styles.updateBanner, { backgroundColor: theme.surface, borderColor: theme.ok }]}
      >
        <Ionicons name="flash" size={18} color={theme.ok} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="caption" style={{ color: theme.ok }}>
            {t('update.otaReady')}
          </Text>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {t('update.otaTapToApply')}
          </Text>
        </View>
      </PressableScale>
    ) : apkUpdate ? (
      <PressableScale
        onPress={() => { Linking.openURL(apkUpdate.apk).catch(() => {}); }}
        haptic
        scaleTo={0.98}
        style={[styles.updateBanner, { backgroundColor: theme.surface, borderColor: theme.accent }]}
      >
        <Ionicons name="arrow-down-circle" size={18} color={theme.accent} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="caption" style={{ color: theme.accent }}>
            {t('update.available', { version: apkUpdate.version })}
          </Text>
          <Text variant="caption" tone="faint" numberOfLines={1}>
            {t('update.tapToInstall')}
          </Text>
        </View>
        <PressableScale onPress={() => setApkUpdate(null)} hitSlop={8}>
          <Ionicons name="close" size={16} color={theme.textFaint} />
        </PressableScale>
      </PressableScale>
    ) : null;

  // Single header used across every state — keeps menu/title/scan placement
  // consistent so loading/error/empty/list don't shift around.
  const renderHeader = () => (
    <View style={styles.headerRow}>
      <PressableScale
        onPress={() => setDrawerOpen(true)}
        haptic
        scaleTo={0.94}
        style={styles.iconBtn}
        hitSlop={6}
      >
        <View
          style={[
            styles.iconBtnFallback,
            { backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        >
          <Ionicons name="menu" size={22} color={theme.text} />
        </View>
      </PressableScale>

      <View style={styles.titleWrap}>
        {currentTeam ? (
          <PressableScale
            onPress={() => setTitleModalOpen(true)}
            haptic={false}
            scaleTo={0.97}
            style={styles.titleBtn}
          >
            <Text variant="h3" numberOfLines={1} style={{ textAlign: 'center' }}>
              {currentTeam.title}
            </Text>
            <Text
              variant="caption"
              tone="faint"
              numberOfLines={1}
              ellipsizeMode="middle"
              style={{ textAlign: 'center', marginTop: 1 }}
            >
              {currentTeam.serverUrl.replace(/^https?:\/\//, '')}
            </Text>
          </PressableScale>
        ) : (
          <Text variant="h3" tone="muted" style={{ textAlign: 'center' }}>
            {t('agents.title')}
          </Text>
        )}
      </View>

      {/* 🪐 雪莉 — 住在手机里的桌宠(WebView 直连桌面机 cicy-pet 服务) */}
      <PressableScale
        onPress={() => router.push('/pet')}
        haptic
        scaleTo={0.94}
        style={[styles.iconBtnFallback, { backgroundColor: theme.surface, borderColor: theme.border, marginRight: 8 }]}
        hitSlop={6}
      >
        <Ionicons name="planet-outline" size={20} color={theme.text} />
      </PressableScale>

      {/* ⊕ — TeamPanel-toolbar parity: create new OR bind an existing unbound
          pane. Cloud tenants have no bindings, so ⊕ goes straight to create.
          (Adding a TEAM lives in the drawer: scan top-right / cloud login.) */}
      <PressableScale
        onPress={() => {
          setCreateType(cloudLocked ? 'cicy' : 'claude');
          setCreateError(null);
          if (cloudLocked) setCreateOpen(true);
          else setAddMenuOpen(true);
        }}
        haptic
        scaleTo={0.94}
        style={[styles.iconBtnFallback, { backgroundColor: theme.surface, borderColor: theme.border }]}
        hitSlop={6}
      >
        <Ionicons name="add" size={24} color={theme.text} />
      </PressableScale>
    </View>
  );

  // ── member management: restart / delete / create (cicy-code endpoints) ──
  const restartAgent = async (id: string) => {
    try {
      await api.restartPane(id);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };
  const deleteAgent = async (id: string) => {
    try {
      await api.deletePane(id);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };
  // Fork = clone workspace+conversation under the same master (TeamPanel menu).
  const forkAgent = async (a: Agent) => {
    const wid = String(a.name ?? a.pane_id ?? '');
    try {
      const res = await api.forkPane({ source_pane_id: wid, master_pane_id: hostPaneId || DEFAULT_MASTER });
      if (res && res.success === false) throw new Error(res.error || 'fork failed');
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };
  // Unbind detaches the pane_agents row (pane survives, re-bindable). The row
  // id rides on /api/poll rows; cloud tenants have no bindings → gated off.
  const unbindMember = async (a: Agent) => {
    const bindingId = Number((a as any).id || 0);
    if (!bindingId) return;
    try {
      await api.unbindAgent(bindingId);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };
  // Bind sheet: unbound = panes whose short id isn't in the roster, minus
  // masters (web's `available`). Fetched fresh on open, like onRefreshPanes.
  const openBindSheet = async () => {
    setBindOpen(true);
    setBindCandidates(null);
    try {
      const panes = await api.getPanes();
      const inRoster = new Set(agents.map((x) => String(x.name ?? x.pane_id ?? '')));
      const seen = new Set<string>();
      const avail: { wid: string; title: string; agentType: string }[] = [];
      for (const p of panes) {
        if (typeof p.pane_id !== 'string' || p.role === 'master') continue;
        const wid = p.pane_id.split(':')[0];
        if (!wid || inRoster.has(wid) || seen.has(wid)) continue;
        seen.add(wid);
        avail.push({ wid, title: p.title || wid, agentType: String(p.agent_type || '') });
      }
      setBindCandidates(avail);
    } catch {
      setBindCandidates([]);
    }
  };
  const bindMember = async (wid: string) => {
    if (bindBusy) return;
    setBindBusy(true);
    try {
      await api.bindAgent({ pane_id: hostPaneId || DEFAULT_MASTER, agent_name: wid });
      setBindOpen(false);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBindBusy(false);
    }
  };
  const createAgent = async () => {
    const title = createName.trim();
    if (!title || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const agentType = cloudLocked ? 'cicy' : createType;
      const res = await api.createPane({
        role: 'worker',
        title,
        agent_type: agentType,
        master_pane_id: hostPaneId || DEFAULT_MASTER,
        ...(cloudLocked ? { master_agent_type: 'cicy' } : {}),
      });
      if (res && res.success === false) throw new Error(res.error || 'create failed');
      setCreateOpen(false);
      setCreateName('');
      await load();
    } catch (e: any) {
      setCreateError(String(e?.message ?? e));
    } finally {
      setCreating(false);
    }
  };

  const createModalEl = (
    <Modal visible={createOpen} transparent animationType="fade" onRequestClose={() => setCreateOpen(false)}>
      <Pressable style={styles.modalBackdrop} onPress={() => setCreateOpen(false)}>
        <Pressable style={[styles.modalCard, { backgroundColor: theme.bg, borderColor: theme.border }]} onPress={() => {}}>
          <Text variant="h3">{t('agents.createMember')}</Text>
          <TextInput
            value={createName}
            onChangeText={setCreateName}
            placeholder={t('agents.createNamePlaceholder')}
            placeholderTextColor={theme.textFaint}
            autoFocus
            style={[
              styles.createInput,
              { fontSize: typeScale.body.fontSize, color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          />
          {cloudLocked ? (
            <Text variant="caption" tone="faint">
              {t('agents.cloudOnlyCicy')}
            </Text>
          ) : (
            <View style={styles.typeChips}>
              {CREATE_TYPES.map((ty) => {
                const active = createType === ty;
                return (
                  <PressableScale
                    key={ty}
                    onPress={() => setCreateType(ty)}
                    scaleTo={0.95}
                    style={[
                      styles.typeChip,
                      {
                        borderColor: active ? theme.accent : theme.border,
                        backgroundColor: active ? theme.surfaceMuted : theme.surface,
                      },
                    ]}
                  >
                    <Text variant="caption" style={active ? { color: theme.accent, fontWeight: '600' } : undefined}>
                      {ty}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>
          )}
          {createError ? (
            <Text variant="caption" tone="danger" numberOfLines={3}>
              {createError}
            </Text>
          ) : null}
          <Button
            title={t('agents.createSubmit')}
            onPress={() => void createAgent()}
            loading={creating}
            disabled={creating || !createName.trim()}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );

  const deleteConfirmEl = (
    <ConfirmModal
      open={!!confirmDelete}
      title={t('agents.deleteConfirmTitle')}
      body={confirmDelete ? t('agents.deleteConfirmBody', { title: confirmDelete.title }) : undefined}
      confirmText={t('agents.delete')}
      cancelText={t('common.cancel')}
      destructive
      onConfirm={() => {
        const target = confirmDelete;
        setConfirmDelete(null);
        if (target) void deleteAgent(target.id);
      }}
      onCancel={() => setConfirmDelete(null)}
    />
  );

  // ── TeamPanel-parity member sheets ──────────────────────────────────────────
  // Long-press action sheet: 解绑 / 重启 / Fork / 删除 — the worker menu web puts
  // behind the row's "…" button. Also the first member actions available on
  // mobile-web, where RNGH swipe never worked.
  const memberMenuEl = (() => {
    const a = memberMenu;
    if (!a) return null;
    const wid = String(a.name ?? a.pane_id ?? '');
    const isMaster = wid === hostPaneId;
    const canRestart = normalizeAgentType(a.agent_type) !== 'cicy';
    const canUnbind = !isMaster && Number((a as any).id || 0) > 0;
    const close = () => setMemberMenu(null);
    const Row = ({ icon, label, danger, onPress }: { icon: any; label: string; danger?: boolean; onPress: () => void }) => (
      <PressableScale onPress={onPress} scaleTo={0.97} style={[styles.sheetRow, { borderColor: theme.border }]}>
        <Ionicons name={icon} size={18} color={danger ? theme.danger : theme.text} />
        <Text variant="body" style={danger ? { color: theme.danger } : undefined}>{label}</Text>
      </PressableScale>
    );
    return (
      <Modal visible transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.sheetBackdrop} onPress={close}>
          <Pressable style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]} onPress={() => {}}>
            <View style={styles.sheetHeader}>
              <AgentAvatar agentType={a.agent_type} title={a.title || wid} size={32} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyMedium" numberOfLines={1}>{a.title || wid}</Text>
                <Text variant="caption" tone="faint" numberOfLines={1}>{wid}</Text>
              </View>
            </View>
            {canRestart ? (
              <Row icon="refresh" label={t('agents.restart')} onPress={() => { close(); void restartAgent(wid); }} />
            ) : null}
            {!isMaster ? (
              <Row icon="git-branch-outline" label={t('agents.fork')} onPress={() => { close(); setConfirmFork(a); }} />
            ) : null}
            {canUnbind ? (
              <Row icon="unlink-outline" label={t('agents.unbind')} onPress={() => { close(); setConfirmUnbind(a); }} />
            ) : null}
            {!isMaster ? (
              <Row icon="trash-outline" label={t('agents.delete')} danger onPress={() => { close(); setConfirmDelete({ id: wid, title: a.title || wid }); }} />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    );
  })();

  const forkConfirmEl = (
    <ConfirmModal
      open={!!confirmFork}
      title={t('agents.forkConfirmTitle')}
      body={confirmFork ? t('agents.forkConfirmBody', { title: confirmFork.title || confirmFork.name || '' }) : undefined}
      confirmText={t('agents.fork')}
      cancelText={t('common.cancel')}
      onConfirm={() => {
        const target = confirmFork;
        setConfirmFork(null);
        if (target) void forkAgent(target);
      }}
      onCancel={() => setConfirmFork(null)}
    />
  );

  const unbindConfirmEl = (
    <ConfirmModal
      open={!!confirmUnbind}
      title={t('agents.unbindConfirmTitle')}
      body={confirmUnbind ? t('agents.unbindConfirmBody', { title: confirmUnbind.title || confirmUnbind.name || '' }) : undefined}
      confirmText={t('agents.unbind')}
      cancelText={t('common.cancel')}
      destructive
      onConfirm={() => {
        const target = confirmUnbind;
        setConfirmUnbind(null);
        if (target) void unbindMember(target);
      }}
      onCancel={() => setConfirmUnbind(null)}
    />
  );

  // ⊕ menu: create new vs bind existing (TeamPanel toolbar = create button +
  // bind select, collapsed into one entry point on mobile).
  const addMenuEl = (
    <Modal visible={addMenuOpen} transparent animationType="fade" onRequestClose={() => setAddMenuOpen(false)}>
      <Pressable style={styles.sheetBackdrop} onPress={() => setAddMenuOpen(false)}>
        <Pressable style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]} onPress={() => {}}>
          <Text variant="h3" style={{ marginBottom: spacing.sm }}>{t('agents.addMenuTitle')}</Text>
          <PressableScale
            onPress={() => { setAddMenuOpen(false); setCreateOpen(true); }}
            scaleTo={0.97}
            style={[styles.sheetRow, { borderColor: theme.border }]}
          >
            <Ionicons name="person-add-outline" size={18} color={theme.text} />
            <Text variant="body">{t('agents.createNew')}</Text>
          </PressableScale>
          <PressableScale
            onPress={() => { setAddMenuOpen(false); void openBindSheet(); }}
            scaleTo={0.97}
            style={[styles.sheetRow, { borderColor: theme.border }]}
          >
            <Ionicons name="link-outline" size={18} color={theme.text} />
            <Text variant="body">{t('agents.bindExisting')}</Text>
          </PressableScale>
        </Pressable>
      </Pressable>
    </Modal>
  );

  const bindSheetEl = (
    <Modal visible={bindOpen} transparent animationType="fade" onRequestClose={() => setBindOpen(false)}>
      <Pressable style={styles.sheetBackdrop} onPress={() => setBindOpen(false)}>
        <Pressable style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]} onPress={() => {}}>
          <Text variant="h3" style={{ marginBottom: spacing.sm }}>{t('agents.bindTitle')}</Text>
          {bindCandidates === null ? (
            <ActivityIndicator color={theme.textMuted} style={{ marginVertical: spacing.lg }} />
          ) : bindCandidates.length === 0 ? (
            <Text variant="callout" tone="muted" style={{ marginVertical: spacing.md, textAlign: 'center' }}>
              {t('agents.bindEmpty')}
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 360 }}>
              {bindCandidates.map((c) => (
                <PressableScale
                  key={c.wid}
                  onPress={() => void bindMember(c.wid)}
                  scaleTo={0.97}
                  style={[styles.sheetRow, { borderColor: theme.border, opacity: bindBusy ? 0.5 : 1 }]}
                >
                  <AgentAvatar agentType={c.agentType} title={c.title} size={28} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text variant="body" numberOfLines={1}>{c.title}</Text>
                    <Text variant="caption" tone="faint" numberOfLines={1}>{c.wid}</Text>
                  </View>
                  <Ionicons name="link-outline" size={16} color={theme.textFaint} />
                </PressableScale>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );

  const drawerEl = <TeamDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />;
  const titleModalEl =
    currentTeam && (
      <TeamTitleModal
        open={titleModalOpen}
        team={currentTeam}
        onClose={() => setTitleModalOpen(false)}
      />
    );

  if (teams.length === 0) {
    return (
      <Screen>
        {renderHeader()}
      {renderUpdateBanner()}
        <View style={styles.center}>
          <View style={[styles.bigIcon, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Ionicons name="qr-code-outline" size={56} color={theme.textMuted} />
          </View>
          <Text variant="title" style={{ marginTop: spacing.lg }}>
            {t('agents.emptyTeamTitle')}
          </Text>
          <Text tone="muted" variant="callout" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {t('agents.emptyTeamHint')}
          </Text>
          <View style={{ height: spacing.xl }} />
          <Button
            title={session ? t('agents.toMachines') : t('login.entry')}
            onPress={() => router.replace(session ? '/machines' : '/login')}
          />
          <PressableScale onPress={() => router.push('/scan')} style={{ paddingVertical: spacing.md }} hitSlop={8}>
            <Text variant="callout" tone="muted">{t('agents.scanToAdd')}</Text>
          </PressableScale>
        </View>
        {drawerEl}
      </Screen>
    );
  }

  if (loading) {
    return (
      <Screen>
        {renderHeader()}
      {renderUpdateBanner()}
        <View style={styles.center}>
          <ActivityIndicator color={theme.textMuted} />
        </View>
        {drawerEl}
        {titleModalEl}
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        {renderHeader()}
      {renderUpdateBanner()}
        <View style={[styles.center, { paddingHorizontal: spacing.xl }]}>
          <Ionicons name="cloud-offline-outline" size={48} color={theme.textMuted} />
          <Text variant="title" style={{ marginTop: spacing.md }}>
            {t('agents.errorTitle')}
          </Text>
          <Text variant="callout" tone="muted" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {error}
          </Text>
          <View style={{ height: spacing.xl }} />
          <Button title={t('common.tryAgain')} onPress={onRefresh} />
        </View>
        {drawerEl}
        {titleModalEl}
      </Screen>
    );
  }

  return (
    <Screen>
      {renderHeader()}
      {renderUpdateBanner()}
      <FlatList
        data={listRows}
        keyExtractor={(r) =>
          r.kind !== 'agent' ? r.key : String(r.agent.name ?? r.agent.id ?? r.agent.pane_id ?? '')
        }
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing['2xl'],
          gap: spacing.sm,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textMuted} />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="terminal-outline" size={48} color={theme.textMuted} />
            <Text tone="muted" variant="callout" style={{ marginTop: spacing.md, textAlign: 'center' }}>
              {hubMode ? t('agents.noProjects') : t('agents.emptyHint')}
            </Text>
          </View>
        }
        renderItem={({ item }) =>
          item.kind === 'project' ? (
            <View style={[styles.projectHeader, { borderBottomColor: theme.border }]}>
              <Ionicons name="folder-open-outline" size={14} color={theme.accent} />
              <Text variant="callout" numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
                {item.label}
              </Text>
              <Text variant="caption" tone="faint">
                {t('agents.projectAgents', { count: item.count })}
              </Text>
            </View>
          ) : item.kind === 'machine' ? (
            <View style={styles.machineHeader}>
              <Ionicons name="hardware-chip-outline" size={12} color={theme.textFaint} />
              <Text variant="caption" tone="faint" numberOfLines={1}>
                {item.label}
              </Text>
            </View>
          ) : (
            // Fork children: indent + a continuous vertical guide rail on the
            // left (web TeamPanel's tree line). The negative top margin bridges
            // the FlatList row gap so consecutive nested rows share one line.
            <View
              style={
                item.depth > 0
                  ? {
                      marginLeft: Math.min(item.depth, 4) * 18,
                      borderLeftWidth: 2,
                      borderLeftColor: theme.border,
                      paddingLeft: 10,
                      marginTop: -spacing.sm,
                      paddingTop: spacing.sm,
                    }
                  : undefined
              }
            >
              <AgentRow
                agent={item.agent}
                metrics={liveMetrics[agentId(item.agent)]}
                gateway={gatewayByName[agentId(item.agent)]}
                forkCount={item.forkCount}
                collapsed={item.collapsed}
                onToggleCollapse={toggleCollapsed}
                onLongPress={(a) => setMemberMenu(a)}
              />
            </View>
          )
        }
      />
      {drawerEl}
      {titleModalEl}
      {createModalEl}
      {deleteConfirmEl}
      {memberMenuEl}
      {forkConfirmEl}
      {unbindConfirmEl}
      {addMenuEl}
      {bindSheetEl}
    </Screen>
  );
}

function AgentRow({
  agent,
  metrics,
  gateway,
  forkCount = 0,
  collapsed = false,
  onToggleCollapse,
  onLongPress,
}: {
  agent: Agent;
  metrics?: AgentLiveMetrics;
  gateway?: boolean;
  // Fork-tree rendering (TeamPanel parity): forkCount>0 shows a collapse
  // chevron, collapsed shows the hidden-descendant count. Indentation + the
  // vertical guide rail are drawn by the renderItem wrapper (depth-aware).
  forkCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: (wid: string) => void;
  onLongPress?: (agent: Agent) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const routeId = agent.name || agent.id || agent.pane_id;

  // Show worker id ("w-10036") under the title — that's the chat-ws routing
  // key and the only stable identifier across renames.
  const workerId = agent.name || String(routeId);

  // Long-press = the single member-actions entry (restart/fork/unbind/delete
  // all live in that sheet — no per-row "…" button, no swipe actions). On
  // RN-Web onLongPress does NOT suppress the subsequent onPress (the row would
  // navigate right over the freshly opened sheet), so guard it manually.
  const longPressFiredRef = useRef(false);

  const row = (
    <PressableScale
      // Hand the row's metadata to the detail screen so the header/terminal
      // button render instantly — the list already knows type + title, no
      // reason to make the chat screen re-await /api/panes for first paint.
      onPress={() => {
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          return;
        }
        router.push({
          pathname: '/chat/[agentId]',
          params: {
            agentId: String(routeId),
            title: agent.title || '',
            agentType: agent.agent_type || '',
            machineLabel: (agent as any).machine_label || '',
          },
        });
      }}
      // In a scrolling list, a touch-down fires onPressIn → the card scales down,
      // then the scroll gesture cancels it → it springs back = a "弹一下" pop while
      // dragging. Delaying press-in lets a scroll (finger moves immediately) abort
      // before any scale fires; a real tap (held still) still scales after the delay.
      unstable_pressDelay={120}
      onLongPress={
        onLongPress
          ? () => {
              longPressFiredRef.current = true;
              onLongPress(agent);
            }
          : undefined
      }
      style={[
        rowStyles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      {forkCount > 0 ? (
        <PressableScale
          onPress={() => onToggleCollapse?.(workerId)}
          hitSlop={8}
          scaleTo={0.9}
          style={rowStyles.collapseBtn}
        >
          <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-down'} size={14} color={theme.textFaint} />
        </PressableScale>
      ) : null}
      <AgentAvatar agentType={agent.agent_type} title={agent.title || agent.name || String(routeId)} size={40} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={rowStyles.titleRow}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>
            {agent.title || agent.name || String(routeId)}
          </Text>
          {collapsed && forkCount > 0 ? (
            <View style={[rowStyles.collapsedBadge, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}>
              <Text variant="caption" tone="muted" style={{ fontSize: 10 }}>
                {t('agents.collapsedCount', { count: forkCount })}
              </Text>
            </View>
          ) : null}
          {/* 网关标识(同 cicy-code team-panel-worker-gateway):
              实心蓝点 = 本地 AI Gateway,空心环 = 官方登录直连。 */}
          {gateway != null ? (
            <View
              style={[
                rowStyles.gatewayDot,
                gateway
                  ? { backgroundColor: 'rgba(56,189,248,0.6)' }
                  : { borderWidth: 1, borderColor: 'rgba(128,128,128,0.6)' },
              ]}
            />
          ) : null}
        </View>
        {/* status · id · model · ctx ring · cost — mirrors cicy-code TeamPanel's metrics line. */}
        <View style={rowStyles.metaRow}>
          <AgentStatusDot working={!!metrics?.working} known={!!metrics} />
          <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
            {workerId}
          </Text>
          {metrics?.model ? (
            <View style={[rowStyles.modelChip, { borderColor: modelColor(metrics.model) }]}>
              <Text variant="caption" numberOfLines={1} style={{ color: modelColor(metrics.model), fontSize: 10 }}>
                {modelShort(metrics.model)}
              </Text>
            </View>
          ) : null}
          {metrics && metrics.ctx > 0 ? <CtxRing pct={metrics.ctx} /> : null}
          {metrics && metrics.cost > 0 ? (
            <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
              {fmtCost(metrics.cost)}
            </Text>
          ) : null}
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={theme.textFaint} />
    </PressableScale>
  );

  return row;
}

const styles = StyleSheet.create({
  updateBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bigIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing['2xl'],
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
    gap: spacing.md,
  },
  // Member/add/bind sheets (TeamPanel-parity actions) — reuse the bottom-sheet
  // shell (sheetBackdrop/sheet/sheetRow) above.
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  machineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: spacing.sm,
  },
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  createInput: {
    width: '100%',
    height: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: 0,
    textAlignVertical: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
  },
  typeChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  typeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  iconBtnFallback: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
  titleBtn: { alignItems: 'center', maxWidth: '100%', paddingVertical: 2, paddingHorizontal: spacing.sm },
});

const rowStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gatewayDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
  // Fork-tree affordances (TeamPanel parity).
  collapseBtn: { marginLeft: -6, marginRight: -4, alignSelf: 'center' },
  collapsedBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'nowrap' },
  modelChip: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 130,
    flexShrink: 0,
  },
});
