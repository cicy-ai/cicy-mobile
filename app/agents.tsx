import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';

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
import { checkApkUpdate, type ApkUpdate } from '@/src/lib/appUpdate';
import { useOtaReady } from '@/src/lib/otaInfo';
import type { Agent } from '@/src/api/types';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import {
  fmtCost,
  metricsFromCurrentReply,
  modelColor,
  modelShort,
  type AgentLiveMetrics,
} from '@/src/lib/agentMetrics';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

// Same list the cicy-code web create-member dialog offers. Cloud default
// teams are server-locked to 'cicy' (per w-10122) — the picker collapses.
const CREATE_TYPES = ['cicy', 'claude', 'codex', 'gemini', 'opencode', 'cursor'] as const;

// We only show the team's master/dispatcher pane and its direct workers. The
// backend returns every agent regardless of host, so we filter client-side.
// cicy-code stamps each worker's master into its pane_id (all of a team's
// workers share it), so the master is derived from /api/poll per load rather
// than hardcoded — teams differ. Falls back to this default when a team has no
// workers yet to derive from.
const DEFAULT_MASTER = 'w-1001';
// Background-aware refresh cadence. 5s feels live without hammering the API.
const POLL_INTERVAL_MS = 5000;

// Live per-agent metrics (model / context / cost) from /api/agents/current-reply,
// polled at 3s — same pipe as cicy-code's TeamPanel. sig-compare keeps unchanged
// agents referentially stable so their rows don't re-render every tick.
function useTeamLiveMetrics(ids: string[]): Record<string, AgentLiveMetrics> {
  const [metrics, setMetrics] = useState<Record<string, AgentLiveMetrics>>({});
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const list = key.split(',').filter(Boolean);
    const poll = async () => {
      await Promise.all(
        list.map(async (wid) => {
          const res: any = await api.getCurrentReply(wid).catch(() => null);
          if (cancelled || !res) return;
          setMetrics((prev) => {
            const next = metricsFromCurrentReply(res, prev[wid]);
            return prev[wid]?.sig === next.sig ? prev : { ...prev, [wid]: next };
          });
        }),
      );
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key]);
  return metrics;
}

export default function Agents() {
  const { t } = useTranslation();
  const theme = useTheme();
  const teams = useAuthStore((s) => s.teams);
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const currentTeam = teams.find((tm) => tm.id === currentTeamId) ?? null;

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
  // ⊕ menu + create-member dialog + swipe-delete confirm state.
  const [plusOpen, setPlusOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<string>('cicy');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  // Cloud default team: server enforces agent_type 'cicy' (w-10122).
  const cloudLocked = !!currentTeam?.builtin;
  // Sideload self-update: newer APK on the CDN → banner (Android only).
  const ota = useOtaReady();
  const [apkUpdate, setApkUpdate] = useState<ApkUpdate | null>(null);
  useEffect(() => {
    let alive = true;
    checkApkUpdate().then((u) => { if (alive && u) setApkUpdate(u); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const agentId = useCallback((a: Agent) => String(a.name || a.id || a.pane_id || ''), []);
  const agentIds = useMemo(() => agents.map(agentId).filter(Boolean), [agents, agentId]);
  const liveMetrics = useTeamLiveMetrics(agentIds);

  const load = useCallback(async () => {
    if (!currentTeam) {
      setAgents([]);
      setError(null);
      return;
    }
    setError(null);
    try {
      // poll() returns workers (and statuses); panes() lets us pull the
      // master row because /api/poll omits role=master rows.
      const [poll, panes] = await Promise.all([api.poll(), api.getPanes()]);

      // Derive the master/dispatcher this team centres on: every worker row from
      // /api/poll carries its master in `pane_id` (e.g. "w-1001"). Fall back to
      // DEFAULT_MASTER when there are no workers to derive from.
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

      // Build lookups from /api/panes (which /api/poll lacks), keyed by the
      // worker name ("w-10036") = prefix of pane_id ("w-10036:main.0"):
      // workspace per worker, and the gateway flag (use_custom_gateway —
      // solid dot = local AI gateway, hollow = official login direct).
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

      const workers = workerRows
        .filter((a) => a.pane_id === hostPane)
        .map((a) => ({
          ...a,
          workspace: a.name ? workspaceByName.get(a.name) : undefined,
        }));

      setAgents([...masters, ...workers]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [currentTeam]);

  // Team switched → wipe the previous team's list immediately. Without this
  // the old agents (and any stale error) linger until the new fetch lands —
  // or forever, if the new team's server errors out.
  useEffect(() => {
    setAgents([]);
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
    if (!currentTeam) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => {
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
  }, [currentTeam, load]);

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

      {/* ⊕ — create a team member, or add a whole team (scan lives in the
          drawer's top-right too) */}
      <PressableScale
        onPress={() => setPlusOpen(true)}
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

  const plusMenuEl = (
    <Modal visible={plusOpen} transparent animationType="fade" onRequestClose={() => setPlusOpen(false)}>
      <Pressable style={styles.sheetBackdrop} onPress={() => setPlusOpen(false)}>
        <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
          <PressableScale
            onPress={() => { setPlusOpen(false); setCreateType(cloudLocked ? 'cicy' : 'claude'); setCreateError(null); setTimeout(() => setCreateOpen(true), 120); }}
            scaleTo={0.98}
            style={styles.sheetRow}
          >
            <Ionicons name="person-add-outline" size={22} color={theme.text} />
            <Text variant="body">{t('agents.createMember')}</Text>
          </PressableScale>
          <PressableScale
            onPress={() => { setPlusOpen(false); setTimeout(() => router.push('/scan'), 120); }}
            scaleTo={0.98}
            style={styles.sheetRow}
          >
            <Ionicons name="scan-outline" size={22} color={theme.text} />
            <Text variant="body">{t('teams.addTeam')}</Text>
          </PressableScale>
        </View>
      </Pressable>
    </Modal>
  );

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
          <Button title={t('agents.scanToAdd')} onPress={() => router.push('/scan')} />
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
        data={agents}
        keyExtractor={(a) => String(a.name ?? a.id ?? a.pane_id ?? '')}
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
              {t('agents.emptyHint')}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <AgentRow
            agent={item}
            metrics={liveMetrics[agentId(item)]}
            gateway={gatewayByName[agentId(item)]}
            isMaster={agentId(item) === hostPaneId}
            onRestart={(id) => void restartAgent(id)}
            onDelete={(id, title) => setConfirmDelete({ id, title })}
          />
        )}
      />
      {drawerEl}
      {titleModalEl}
      {plusMenuEl}
      {createModalEl}
      {deleteConfirmEl}
    </Screen>
  );
}

function AgentRow({
  agent,
  metrics,
  gateway,
  isMaster,
  onRestart,
  onDelete,
}: {
  agent: Agent;
  metrics?: AgentLiveMetrics;
  gateway?: boolean;
  isMaster?: boolean;
  onRestart?: (id: string) => void;
  onDelete?: (id: string, title: string) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const routeId = agent.name || agent.id || agent.pane_id;
  const swipeRef = useRef<Swipeable | null>(null);

  // Show worker id ("w-10036") under the title — that's the chat-ws routing
  // key and the only stable identifier across renames.
  const workerId = agent.name || String(routeId);

  // Swipe-left actions (native only; RNGH Swipeable is unreliable on web):
  // restart for everyone, delete for workers (the master is the team).
  const renderRightActions = () => (
    <View style={rowStyles.swipeActions}>
      <PressableScale
        onPress={() => { swipeRef.current?.close(); onRestart?.(String(routeId)); }}
        style={[rowStyles.swipeBtn, { backgroundColor: theme.surfaceMuted }]}
        scaleTo={0.95}
        haptic
      >
        <Ionicons name="refresh" size={20} color={theme.text} />
        <Text variant="caption">{t('agents.restart')}</Text>
      </PressableScale>
      {!isMaster && (
        <PressableScale
          onPress={() => {
            swipeRef.current?.close();
            onDelete?.(String(routeId), agent.title || agent.name || String(routeId));
          }}
          style={[rowStyles.swipeBtn, { backgroundColor: theme.danger }]}
          scaleTo={0.95}
          haptic
        >
          <Ionicons name="trash-outline" size={20} color="#fff" />
          <Text variant="caption" style={{ color: '#fff' }}>{t('agents.delete')}</Text>
        </PressableScale>
      )}
    </View>
  );

  const row = (
    <PressableScale
      // Hand the row's metadata to the detail screen so the header/terminal
      // button render instantly — the list already knows type + title, no
      // reason to make the chat screen re-await /api/panes for first paint.
      onPress={() =>
        router.push({
          pathname: '/chat/[agentId]',
          params: {
            agentId: String(routeId),
            title: agent.title || '',
            agentType: agent.agent_type || '',
            machineLabel: (agent as any).machine_label || '',
          },
        })
      }
      // In a scrolling list, a touch-down fires onPressIn → the card scales down,
      // then the scroll gesture cancels it → it springs back = a "弹一下" pop while
      // dragging. Delaying press-in lets a scroll (finger moves immediately) abort
      // before any scale fires; a real tap (held still) still scales after the delay.
      unstable_pressDelay={120}
      style={[
        rowStyles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <AgentAvatar agentType={agent.agent_type} title={agent.title || agent.name || String(routeId)} size={40} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={rowStyles.titleRow}>
          <Text variant="bodyMedium" numberOfLines={1} style={{ flexShrink: 1 }}>
            {agent.title || agent.name || String(routeId)}
          </Text>
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

  // Web: RNGH Swipeable is unreliable there — plain row, no swipe actions.
  if (Platform.OS === 'web') return row;
  return (
    <Swipeable
      ref={swipeRef}
      renderRightActions={renderRightActions}
      overshootRight={false}
      friction={2}
    >
      {row}
    </Swipeable>
  );
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
  swipeActions: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginLeft: spacing.sm,
    gap: spacing.xs,
  },
  swipeBtn: {
    width: 68,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
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
