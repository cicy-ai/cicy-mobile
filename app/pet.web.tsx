// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// 雪莉——web 变体:react-native-webview 没有 web 实现,用 iframe(同 TerminalView.web)。
// hub token 从 auth store 现取,拼进 pet.hub 域名地址。
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { useAuthStore } from '@/src/store/auth';
import { spacing } from '@/src/theme';

const HUB_BASE = 'https://pet.hub.cicy-ai.com';

export default function PetScreen() {
  const hubs = useAuthStore((s) => s.hubs);
  const [remote, setRemote] = useState(false);

  const hubToken = useMemo(() => {
    const h = hubs.find((x) => x.url.includes('cicy-ai.com')) ?? hubs[0];
    return h?.token ?? '';
  }, [hubs]);

  const url = useMemo(() => {
    if (!hubToken) return null;
    const page = remote ? 'remote.html' : 'pet.html';
    return `${HUB_BASE}/${page}?token=${encodeURIComponent(hubToken)}`;
  }, [hubToken, remote]);

  return (
    <Screen edges={['top']} style={{ backgroundColor: '#05070f' }}>
      <View style={styles.headerRow}>
        <PressableScale onPress={() => router.back()} hitSlop={8} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={22} color="#cfe4ff" />
        </PressableScale>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="h3" style={{ color: '#cfe4ff' }}>{remote ? '雪莉 · 导演台' : '雪莉'}</Text>
        </View>
        <PressableScale onPress={() => setRemote((v) => !v)} hitSlop={8} style={{ padding: spacing.xs }}>
          <Ionicons name={remote ? 'eye-outline' : 'game-controller-outline'} size={20} color="#8cdcff" />
        </PressableScale>
      </View>
      {url ? (
        <iframe src={url} style={{ flex: 1, border: 'none', backgroundColor: '#05070f' } as never} allow="microphone; autoplay" />
      ) : (
        <View style={styles.empty}>
          <Text style={{ color: '#cfe4ff', textAlign: 'center' }}>
            还没连上雪莉的星球{'\n'}
            <Text variant="caption" style={{ color: '#86a8d8' }}>先在首页加一个 hub</Text>
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
});
