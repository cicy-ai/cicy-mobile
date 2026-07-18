// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// 雪莉(Sherlly)——住进手机的桌宠。
// 手机是纯观察窗:WebView 直连桌面机 cicy-pet 的渲染服务(默认 :13004),
// Live2D 形象、语音、大脑全部由桌面机伺服,这里零逻辑——服务端改 HTML,
// 手机端即时生效(hot replace),永远不用重装 App。
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { radius, spacing, useTheme } from '@/src/theme';

const URL_KEY = 'sherlly.petUrl';
const DEFAULT_URL = 'https://pet.cicy-ai.com/pet.html';

export default function PetScreen() {
  const theme = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [remote, setRemote] = useState(false);   // false=看她(pet.html) true=导演台(remote.html)
  const [draft, setDraft] = useState('');
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem(URL_KEY);
      setUrl(saved || DEFAULT_URL);
    })();
  }, []);

  const save = useCallback(async () => {
    const v = draft.trim();
    if (v) {
      const normalized = /^https?:\/\//.test(v) ? v : `http://${v}`;
      await storage.setItem(URL_KEY, normalized);
      setUrl(normalized);
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
          <Text variant="h3" style={{ color: '#cfe4ff' }}>{remote ? '雪莉 · 导演台' : '雪莉'}</Text>
        </View>
        {/* 看她 ↔ 导演台(遥控桌面上的她:开拍/动作/让她说话) */}
        <PressableScale onPress={() => setRemote((v) => !v)} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name={remote ? 'eye-outline' : 'game-controller-outline'} size={20} color="#8cdcff" />
        </PressableScale>
        <PressableScale
          onPress={() => { setDraft(url ?? DEFAULT_URL); setEditOpen(true); }}
          hitSlop={8}
          style={styles.iconBtn}
        >
          <Ionicons name="settings-outline" size={20} color="#cfe4ff" />
        </PressableScale>
      </View>

      {url ? (
        <WebView
          ref={webRef}
          source={{ uri: remote ? url.replace(/pet\.html.*/, 'remote.html') : url }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
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
                  确认桌面机 cicy-pet 已启动,手机和它同一 Wi-Fi,右上角改地址
                </Text>
              </Text>
            </View>
          )}
          style={{ flex: 1, backgroundColor: '#05070f' }}
        />
      ) : (
        <View style={styles.loading}>
          <ActivityIndicator color="#8cdcff" />
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
              placeholder={DEFAULT_URL}
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
