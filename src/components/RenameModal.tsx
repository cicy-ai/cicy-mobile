// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Generic bottom rename card: heading + subtitle + one input + save/cancel.
// `onSave` does the network call; a thrown error is shown inline and the card
// stays open. Used for project names (agents use AgentTitleModal, which adds
// the avatar preview).
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

import { Button } from './Button';
import { Text } from './Text';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

type Props = {
  open: boolean;
  heading: string;
  subtitle?: string;
  icon?: ReactNode;
  value: string;
  placeholder?: string;
  onClose: () => void;
  onSave: (next: string) => Promise<void>;
};

export function RenameModal({ open, heading, subtitle, icon, value, placeholder, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [draft, setDraft] = useState(value);
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
      setDraft(value);
      setError(null);
    } else {
      Keyboard.dismiss();
    }
  }, [open, value]);

  async function save() {
    const next = draft.trim();
    if (!next || next === value) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
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
            {icon}
            <View style={{ flex: 1 }}>
              <Text variant="h3">{heading}</Text>
              {subtitle ? (
                <Text variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </View>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholder}
            placeholderTextColor={theme.textFaint}
            autoFocus
            selectTextOnFocus
            maxLength={48}
            style={[styles.input, typeScale.body, { color: theme.text, backgroundColor: theme.bg, borderColor: theme.border }]}
            returnKeyType="done"
            onSubmitEditing={() => void save()}
          />
          {error ? (
            <Text variant="caption" tone="danger" style={{ marginTop: spacing.sm }}>
              {error}
            </Text>
          ) : null}
          <View style={styles.btnRow}>
            <View style={{ flex: 1 }} />
            <Button title={t('common.cancel')} variant="ghost" onPress={onClose} disabled={saving} />
            <Button title={t('common.ok')} onPress={() => void save()} loading={saving} disabled={saving || !draft.trim()} />
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
  input: { height: 48, paddingHorizontal: spacing.md, paddingVertical: 0, borderRadius: radius.md, borderWidth: 1 },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
});
