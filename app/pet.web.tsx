// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// 雪莉——web 变体:react-native-webview 没有 web 实现,用 iframe(同 TerminalView.web)。
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { storage } from '@/src/store/storage';
import { spacing } from '@/src/theme';

const URL_KEY = 'sherlly.petUrl';
const DEFAULT_URL = 'http://192.168.253.244:13004/pet.html';

export default function PetScreen() {
  const [url, setUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await storage.getItem(URL_KEY);
      setUrl(saved || DEFAULT_URL);
      setDraft(saved || DEFAULT_URL);
    })();
  }, []);

  return (
    <Screen edges={['top']} style={{ backgroundColor: '#05070f' }}>
      <View style={styles.headerRow}>
        <PressableScale onPress={() => router.back()} hitSlop={8} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={22} color="#cfe4ff" />
        </PressableScale>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="h3" style={{ color: '#cfe4ff' }}>雪莉</Text>
        </View>
        <PressableScale onPress={() => setEditing((v) => !v)} hitSlop={8} style={{ padding: spacing.xs }}>
          <Ionicons name="settings-outline" size={20} color="#cfe4ff" />
        </PressableScale>
      </View>
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={async () => {
            const v = draft.trim();
            if (v) {
              const normalized = /^https?:\/\//.test(v) ? v : `http://${v}`;
              await storage.setItem(URL_KEY, normalized);
              setUrl(normalized);
            }
            setEditing(false);
          }}
          autoCapitalize="none"
          style={styles.input}
        />
      ) : null}
      {url ? (
        <iframe src={url} style={{ flex: 1, border: 'none', backgroundColor: '#05070f' } as never} allow="microphone; autoplay" />
      ) : null}
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
  input: {
    borderWidth: 1,
    borderColor: '#334',
    color: '#cfe4ff',
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 8,
    fontSize: 13,
  },
});
