// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Rename an agent: bottom card with the avatar preview, one input, save /
// cancel. PATCH /api/tmux/panes/<id> {title} — the same field the web
// Project Agent Cards edit. Opened from the chat header (tap the title) and
// from the agent list's long-press menu.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AgentAvatar } from './AgentAvatar';
import { Button } from './Button';
import { Text } from './Text';
import { api } from '@/src/api/http';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

type Props = {
  open: boolean;
  agentId: string;
  title: string;
  agentType?: string;
  onClose: () => void;
  /** Called with the new title after the server accepted it. */
  onSaved: (title: string) => void;
};

export function AgentTitleModal({ open, agentId, title, agentType, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: open ? 220 : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [open, anim]);
  useEffect(() => {
    if (open) {
      setDraft(title);
      setError(null);
    } else {
      // The input auto-focused; closing the card must take the keyboard with
      // it, or it stays up over a composer that is in voice mode.
      Keyboard.dismiss();
    }
  }, [open, title]);

  async function onSave() {
    const next = draft.trim();
    if (!next || next === title) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updatePane(agentId, { title: next });
      onSaved(next);
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: anim }]}>
          <Pressable style={styles.scrim} onPress={onClose} />
        </Animated.View>
        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
              opacity: anim,
              transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <View style={styles.headerRow}>
            <AgentAvatar agentType={agentType} title={draft || title} size={44} />
            <View style={{ flex: 1 }}>
              <Text variant="h3">{t('agents.renameTitle')}</Text>
              <Text variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                {agentId}
              </Text>
            </View>
          </View>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('agents.titlePlaceholder')}
            placeholderTextColor={theme.textFaint}
            autoFocus
            selectTextOnFocus
            maxLength={48}
            style={[styles.input, typeScale.body, { color: theme.text, backgroundColor: theme.bg, borderColor: theme.border }]}
            returnKeyType="done"
            onSubmitEditing={() => void onSave()}
          />
          {error ? (
            <Text variant="caption" tone="danger" style={{ marginTop: spacing.sm }}>
              {error}
            </Text>
          ) : null}
          <View style={styles.btnRow}>
            <View style={{ flex: 1 }} />
            <Button title={t('common.cancel')} variant="ghost" onPress={onClose} disabled={saving} />
            <Button title={t('common.ok')} onPress={() => void onSave()} loading={saving} disabled={saving || !draft.trim()} />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0008' },
  card: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: spacing.xs },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  input: {
    height: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: 0,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
});
