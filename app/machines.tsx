// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Machines — every cicy-code instance of the signed-in CiCy Hub account, one
// card each (name, liveness, version, agent count, live usage). Tapping a
// machine makes it the current team and opens its projects/agents list. The
// rows come from the auth store's hub directory (refreshed on a 60s heartbeat
// and on pull-to-refresh).
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { StatusDot } from '@/src/components/StatusDot';
import { TeamAvatar } from '@/src/components/TeamAvatar';
import { TeamDrawer } from '@/src/components/TeamDrawer';
import { Text } from '@/src/components/Text';
import { isOpenableInstance, type HubInstance } from '@/src/api/hubAuth';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

function pct(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '–';
}

function relTime(iso: string | undefined, t: (k: string, o?: any) => string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('time.justNow', { defaultValue: 'just now' });
  if (m < 60) return t('time.minutesAgo', { defaultValue: '{{n}} min ago', n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t('time.hoursAgo', { defaultValue: '{{n}} h ago', n: h });
  return t('time.daysAgo', { defaultValue: '{{n}} d ago', n: Math.floor(h / 24) });
}

export default function Machines() {
  const { t } = useTranslation();
  const theme = useTheme();
  const session = useAuthStore((s) => s.session);
  const userEmail = useAuthStore((s) => s.userEmail);
  const instances = useAuthStore((s) => s.instances);
  const loading = useAuthStore((s) => s.instancesLoading);
  const error = useAuthStore((s) => s.instancesError);
  const syncInstances = useAuthStore((s) => s.syncInstances);
  const teams = useAuthStore((s) => s.teams);
  const switchTeam = useAuthStore((s) => s.switchTeam);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    dismissBootSplash();
  }, []);

  // Signed out (token revoked elsewhere, or logout) → back through the gate.
  useEffect(() => {
    if (!session) router.replace('/');
  }, [session]);

  // Online machines first, then by name (the same order the desktop uses).
  const machines = useMemo(
    () =>
      instances
        .filter(isOpenableInstance)
        .sort((a, b) => Number(!!b.online) - Number(!!a.online) || a.name.localeCompare(b.name)),
    [instances],
  );
  const onlineCount = machines.filter((m) => m.online).length;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await syncInstances();
    setRefreshing(false);
  }, [syncInstances]);

  const open = useCallback(
    async (inst: HubInstance) => {
      const team = teams.find((tm) => tm.kind === 'hub' && tm.instanceId === inst.instanceId);
      if (!team) return;
      await switchTeam(team.id);
      router.push('/agents');
    },
    [teams, switchTeam],
  );

  const renderHeader = () => (
    <View style={styles.headerRow}>
      <PressableScale onPress={() => setDrawerOpen(true)} haptic scaleTo={0.94} hitSlop={6}>
        <View style={[styles.iconBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Ionicons name="menu" size={22} color={theme.text} />
        </View>
      </PressableScale>
      <View style={styles.titleWrap}>
        <Text variant="h3" numberOfLines={1} style={{ textAlign: 'center' }}>
          {t('machines.title')}
        </Text>
        <Text variant="caption" tone="faint" numberOfLines={1} style={{ textAlign: 'center', marginTop: 1 }}>
          {machines.length
            ? t('machines.subtitle', { count: machines.length, online: onlineCount })
            : userEmail || ''}
        </Text>
      </View>
      <PressableScale onPress={() => void onRefresh()} haptic scaleTo={0.94} hitSlop={6}>
        <View style={[styles.iconBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Ionicons name="refresh" size={20} color={theme.text} />
        </View>
      </PressableScale>
    </View>
  );

  const renderCard = ({ item }: { item: HubInstance }) => {
    const res = item.resources || null;
    const usage = res
      ? [`CPU ${pct(res.cpu_usage_pct)}`, `RAM ${pct(res.mem_usage_pct)}`, `Disk ${pct(res.disk_usage_pct)}`]
      : [];
    const agentCount = Array.isArray(item.agents) ? item.agents.length : null;
    const working = Array.isArray(item.agents) ? item.agents.filter((a) => a.working).length : 0;
    const reachable = item.proxyAvailable || item.online;
    return (
      <PressableScale
        onPress={() => void open(item)}
        haptic
        scaleTo={0.98}
        style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border, opacity: reachable ? 1 : 0.7 }]}
      >
        <TeamAvatar id={`inst:${item.instanceId}`} title={item.name} size={44} bordered />
        <View style={{ flex: 1, gap: 3 }}>
          <View style={styles.nameRow}>
            <Text variant="callout" numberOfLines={1} style={{ flexShrink: 1 }}>
              {item.name}
            </Text>
            <StatusDot tone={item.online ? 'ok' : 'muted'} size={8} pulse={item.online && working > 0} />
            <Text variant="caption" tone={item.online ? undefined : 'faint'} style={item.online ? { color: theme.ok } : undefined}>
              {item.online ? t('machines.online') : reachable ? t('machines.offline') : t('machines.unreachable')}
            </Text>
          </View>
          <Text variant="caption" tone="faint" numberOfLines={1} ellipsizeMode="middle">
            {item.proxyHost}
            {item.version ? ` · v${item.version}` : ''}
          </Text>
          <View style={styles.metaRow}>
            <Ionicons name="people-outline" size={12} color={theme.textFaint} />
            <Text variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 0 }}>
              {agentCount == null
                ? t('machines.noAgents')
                : agentCount === 0
                ? t('machines.noAgents')
                : t('machines.agents', { count: agentCount })}
              {working > 0 ? ` · ${working} ⚡` : ''}
            </Text>
            {usage.length ? (
              <Text variant="caption" tone="faint" numberOfLines={1} style={{ flex: 1, flexShrink: 1 }}>
                {' · '}
                {usage.join(' · ')}
              </Text>
            ) : null}
          </View>
          {!item.online && item.lastSeenAt ? (
            <Text variant="caption" tone="faint">
              {t('machines.lastSeen', { when: relTime(item.lastSeenAt, t) })}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.textFaint} />
      </PressableScale>
    );
  };

  const drawerEl = <TeamDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />;

  return (
    <Screen>
      {renderHeader()}
      <FlatList
        data={machines}
        keyExtractor={(m) => m.instanceId}
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
            <View style={[styles.bigIcon, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Ionicons
                name={error ? 'cloud-offline-outline' : 'hardware-chip-outline'}
                size={56}
                color={theme.textMuted}
              />
            </View>
            <Text variant="title" style={{ marginTop: spacing.lg, textAlign: 'center' }}>
              {error ? t('machines.errorTitle') : loading ? '' : t('machines.emptyTitle')}
            </Text>
            <Text tone="muted" variant="callout" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
              {error
                ? error === 'unauthorized'
                  ? t('machines.sessionLost')
                  : error
                : loading
                ? ''
                : t('machines.emptyHint')}
            </Text>
            <View style={{ height: spacing.xl }} />
            <Button title={t('machines.refresh')} onPress={() => void onRefresh()} loading={loading && !refreshing} />
          </View>
        }
        renderItem={renderCard}
      />
      {drawerEl}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  bigIcon: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
