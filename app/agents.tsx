import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { StatusDot } from '@/src/components/StatusDot';
import { Text } from '@/src/components/Text';
import { api } from '@/src/api/http';
import type { Agent } from '@/src/api/types';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

export default function Agents() {
  const theme = useTheme();
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.poll();
      setAgents(data.agents ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={theme.textMuted} />
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen padded>
        <View style={styles.center}>
          <Text variant="title">Couldn't reach cicy-code</Text>
          <Text variant="callout" tone="muted" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {error}
          </Text>
          <View style={{ height: spacing.xl }} />
          <Button title="Try again" onPress={onRefresh} />
          <View style={{ height: spacing.sm }} />
          <Button title="Open settings" variant="ghost" onPress={() => router.push('/settings')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={agents}
        keyExtractor={(a) => String(a.name ?? a.id ?? a.pane_id ?? '')}
        contentContainerStyle={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          paddingBottom: spacing['2xl'],
          gap: spacing.md,
        }}
        ListHeaderComponent={
          <View style={{ marginBottom: spacing.lg }}>
            <Text variant="display">Agents</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: spacing.sm }}>
              <Text variant="callout" tone="muted">
                {agents.length} connected
              </Text>
              <Text variant="caption" tone="faint">
                ·
              </Text>
              <PressableScale haptic={false} onPress={() => router.push('/settings')} style={{ flex: 1 }}>
                <Text variant="caption" tone="faint" numberOfLines={1} ellipsizeMode="head">
                  {serverUrl ?? '(no server)'}
                </Text>
              </PressableScale>
            </View>
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textMuted} />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text tone="muted" variant="callout" style={{ textAlign: 'center' }}>
              No agents yet. Start one in cicy-code on your desktop.
            </Text>
            <View style={{ height: spacing.lg }} />
            <Button title="Open settings" variant="secondary" onPress={() => router.push('/settings')} fullWidth={false} />
          </View>
        }
        renderItem={({ item }) => <AgentRow agent={item} />}
      />
    </Screen>
  );
}

function AgentRow({ agent }: { agent: Agent }) {
  const theme = useTheme();
  // The chat-ws hub keys subscriptions on `name` (e.g. "w-10018") — that's
  // what the web UI uses too. `id` is a DB row id that nothing routes by.
  const routeId = agent.name || agent.id || agent.pane_id;
  const status = (agent.status ?? 'idle').toLowerCase();
  const tone: 'ok' | 'warn' | 'muted' =
    status.includes('think') || status.includes('busy') ? 'warn' : status === 'idle' ? 'ok' : 'muted';

  return (
    <PressableScale
      onPress={() => router.push({ pathname: '/chat/[agentId]', params: { agentId: String(routeId) } })}
      style={[
        rowStyles.card,
        { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="h3">{agent.title || agent.name || String(routeId)}</Text>
        <Text variant="caption" tone="faint">
          {agent.name || String(routeId)}
          {agent.agent_type ? ` · ${agent.agent_type}` : ''}
        </Text>
      </View>
      <View style={rowStyles.statusGroup}>
        <StatusDot tone={tone} pulse={tone === 'warn'} />
        <Text variant="caption" tone="muted" style={{ textTransform: 'capitalize' }}>
          {status}
        </Text>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },
});

const rowStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
