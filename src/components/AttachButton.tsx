// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import {
  pickDocuments, pickImages, takePhoto, type PendingAttachment,
} from '@/src/lib/attachments';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  onPick: (atts: PendingAttachment[]) => void;
  onError?: (msg: string) => void;
  disabled?: boolean;
};

// Paperclip button that opens a bottom action menu: take photo / pick image /
// pick file. Selected items are handed to onPick as PendingAttachment[].
export function AttachButton({ onPick, onError, disabled }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);

  async function run(fn: () => Promise<PendingAttachment[]>) {
    setMenuOpen(false);
    try {
      const atts = await fn();
      if (atts.length) onPick(atts);
    } catch (e: any) {
      onError?.(String(e?.message ?? e));
    }
  }

  const items: { icon: any; label: string; fn: () => Promise<PendingAttachment[]> }[] = [
    { icon: 'camera-outline', label: t('attach.takePhoto'), fn: takePhoto },
    { icon: 'image-outline', label: t('attach.pickImage'), fn: pickImages },
    { icon: 'document-outline', label: t('attach.pickFile'), fn: pickDocuments },
  ];

  return (
    <>
      <PressableScale
        onPress={() => setMenuOpen(true)}
        disabled={disabled}
        haptic
        scaleTo={0.94}
        style={[styles.btn, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <Ionicons name="add" size={24} color={theme.text} />
      </PressableScale>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
          <View
            style={[
              styles.sheet,
              { backgroundColor: theme.bg, borderColor: theme.border, paddingBottom: insets.bottom + spacing.md },
            ]}
          >
            {items.map((it) => (
              <PressableScale
                key={it.label}
                onPress={() => run(it.fn)}
                scaleTo={0.98}
                style={styles.row}
              >
                <Ionicons name={it.icon} size={22} color={theme.text} />
                <Text variant="body">{it.label}</Text>
              </PressableScale>
            ))}
            <PressableScale onPress={() => setMenuOpen(false)} scaleTo={0.98} style={[styles.row, styles.cancel]}>
              <Text variant="bodyMedium" tone="muted">{t('attach.cancel')}</Text>
            </PressableScale>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  cancel: { justifyContent: 'center' },
});
