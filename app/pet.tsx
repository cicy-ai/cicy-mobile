// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// 雪莉(Sherlly)——住进手机的桌宠。
// 手机是纯观察窗:WebView 直连桌面机 cicy-pet 的渲染服务(默认 :13004),
// Live2D 形象、语音、大脑全部由桌面机伺服,这里零逻辑——服务端改 HTML,
// 手机端即时生效(hot replace),永远不用重装 App。
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { storage } from '@/src/store/storage';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

const URL_KEY = 'sherlly.petUrl';
// 雪莉的皮囊经 hub 网关暴露:pet.hub.cicy-ai.com → 桌面机 :13004。
// 需带 hub token(App 已存,连 hub 拉 agent 用的同一把);首屏带 ?token= 后
// hub 种 7 天 cookie,后续同源资源自动放行。token 不硬编码,从 auth store 取。
const HUB_BASE = 'https://pet.hub.cicy-ai.com';

export default function PetScreen() {
  const theme = useTheme();
  const hubs = useAuthStore((s) => s.hubs);
  const [override, setOverride] = useState<string | null>(null);   // 手动填的自定义地址(优先)
  const [ready, setReady] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [view, setView] = useState<'pet' | 'remote' | 'config'>('pet');   // 看她 / 导演台 / 设置
  const [draft, setDraft] = useState('');
  const webRef = useRef<WebView>(null);

  // hub token:优先 cicy-ai.com 那个 hub,退而取第一个
  const hubToken = useMemo(() => {
    const h = hubs.find((x) => x.url.includes('cicy-ai.com')) ?? hubs[0];
    return h?.token ?? '';
  }, [hubs]);

  const PAGE = { pet: 'pet.html', remote: 'remote.html', config: 'config.html' } as const;
  const TITLE = { pet: '雪莉', remote: '雪莉 · 导演台', config: '雪莉 · 设置' } as const;

  // 最终地址:自定义覆盖 > hub 域名(带 token)。三个视图只换文件名。
  const url = useMemo(() => {
    const page = PAGE[view];
    if (override) return override.replace(/(pet|remote|config)\.html.*/, page);
    if (!hubToken) return null;   // 还没连 hub → 提示去扫码加 hub
    return `${HUB_BASE}/${page}?token=${encodeURIComponent(hubToken)}`;
  }, [override, hubToken, view]);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem(URL_KEY);
      setOverride(saved || null);
      setReady(true);
    })();
  }, []);

  const save = useCallback(async () => {
    const v = draft.trim();
    if (v) {
      const normalized = /^https?:\/\//.test(v) ? v : `http://${v}`;
      await storage.setItem(URL_KEY, normalized);
      setOverride(normalized);
    } else {
      await storage.removeItem(URL_KEY);   // 清空 = 回到 hub 默认
      setOverride(null);
    }
    setEditOpen(false);
  }, [draft]);

  return (
    <Screen edges={['top']} style={{ backgroundColor: '#05070f' }}>
      <View style={styles.headerRow}>
        <PressableScale onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color="#cfe4ff" />
        </PressableScale>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="h3" style={{ color: '#cfe4ff' }}>{TITLE[view]}</Text>
        </View>
        {/* 看她 */}
        <PressableScale onPress={() => setView('pet')} hitSlop={6} style={styles.iconBtn}>
          <Ionicons name="eye-outline" size={20} color={view === 'pet' ? '#8cdcff' : '#4a6a9a'} />
        </PressableScale>
        {/* 导演台(遥控:开拍/动作/让她说话) */}
        <PressableScale onPress={() => setView('remote')} hitSlop={6} style={styles.iconBtn}>
          <Ionicons name="game-controller-outline" size={20} color={view === 'remote' ? '#8cdcff' : '#4a6a9a'} />
        </PressableScale>
        {/* 设置(换形象/换音色/试听) */}
        <PressableScale onPress={() => setView('config')} hitSlop={6} style={styles.iconBtn}>
          <Ionicons name="options-outline" size={20} color={view === 'config' ? '#8cdcff' : '#4a6a9a'} />
        </PressableScale>
        <PressableScale
          onPress={() => { setDraft(override ?? ''); setEditOpen(true); }}
          hitSlop={8}
          style={styles.iconBtn}
        >
          <Ionicons name="settings-outline" size={20} color="#cfe4ff" />
        </PressableScale>
      </View>

      {!ready ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#8cdcff" />
        </View>
      ) : url ? (
        <WebView
          ref={webRef}
          key={url}
          source={{ uri: url }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          // hub 种的 cookie 要能存下来,子资源才自动放行
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // 按住雪莉说话要用手机麦克风(getUserMedia)——安卓侧直接放行。
          // (prop 在 13.x 运行时存在但类型定义缺失,spread 绕过类型检查)
          {...({ onPermissionRequest: (e: { grant?: () => void }) => e.grant?.() } as object)}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator color="#8cdcff" />
              <Text variant="caption" style={{ color: '#86a8d8', marginTop: spacing.sm }}>
                正在穿过网线……
              </Text>
            </View>
          )}
          renderError={() => (
            <View style={styles.loading}>
              <Text style={{ color: '#cfe4ff', textAlign: 'center' }}>
                连不上雪莉的星球{'\n'}
                <Text variant="caption" style={{ color: '#86a8d8' }}>
                  确认桌面机服务已启动,右上角 ⚙️ 可改地址
                </Text>
              </Text>
            </View>
          )}
          style={{ flex: 1, backgroundColor: '#05070f' }}
        />
      ) : (
        <View style={styles.loading}>
          <Ionicons name="planet-outline" size={48} color="#2a4a80" />
          <Text style={{ color: '#cfe4ff', textAlign: 'center', marginTop: spacing.md }}>
            还没连上雪莉的星球{'\n'}
            <Text variant="caption" style={{ color: '#86a8d8' }}>
              先在首页扫码加一个 hub,或右上角 ⚙️ 手动填地址
            </Text>
          </Text>
        </View>
      )}

      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalBackdrop}
        >
          <View style={[styles.modalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text variant="h3">雪莉的星球地址</Text>
            <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
              桌面机 cicy-pet 服务,例:192.168.1.10:13004/pet.html
            </Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="留空=用 hub 默认;或填 http://局域网IP:13004/pet.html"
              placeholderTextColor={theme.textFaint}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
              <View style={{ flex: 1 }}><Button title="取消" variant="ghost" onPress={() => setEditOpen(false)} /></View>
              <View style={{ flex: 1 }}><Button title="保存" onPress={save} /></View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  iconBtn: { padding: spacing.xs },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#05070f',
    padding: spacing.lg,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
    fontSize: 14,
  },
});
