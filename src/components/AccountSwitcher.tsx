// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Global account switcher — a WeChat-style sheet listing every cloud account
// signed in on this device. The drawer shows only the CURRENT account plus a
// small switch button that opens this. Tap an account → switch; ✕ → remove;
// bottom row → add another (email login).
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConfirmModal } from './ConfirmModal';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

function tierLabel(tier: string | null): string {
  switch (tier) {
    case 'personal':
      return 'Free';
    case 'team':
      return 'Team';
    case 'enterprise':
      return 'Enterprise';
    default:
      return '';
  }
}

type Props = { open: boolean; onClose: () => void };

export function AccountSwitcher({ open, onClose }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const accounts = useAuthStore((s) => s.accounts);
  const session = useAuthStore((s) => s.session);
  const userEmail = useAuthStore((s) => s.userEmail);
  const tier = useAuthStore((s) => s.tier);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const [switching, setSwitching] = useState<string | null>(null);
  const [confirmAccount, setConfirmAccount] = useState<string | null>(null);

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.fill}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.bg, borderColor: theme.border, paddingBottom: insets.bottom + spacing.md },
          ]}
        >
          <View style={styles.grabber} pointerEvents="none">
            <View style={[styles.grabberBar, { backgroundColor: theme.border }]} />
          </View>
          <Text variant="title" style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            {t('account.switchTitle', { defaultValue: 'Accounts' })}
          </Text>

          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ paddingBottom: spacing.sm }}>
            {accounts.map((acct) => {
              const active = session != null && acct.email.toLowerCase() === (userEmail || '').toLowerCase();
              const busy = switching === acct.email;
              return (
                <PressableScale
                  key={acct.email.toLowerCase()}
                  onPress={() => {
                    if (active || switching) return;
                    setSwitching(acct.email);
                    void (async () => {
                      try {
                        await switchAccount(acct.email);
                      } finally {
                        setSwitching(null);
                        onClose();
                      }
                    })();
                  }}
                  haptic
                  scaleTo={0.98}
                  style={[styles.row, active && { backgroundColor: theme.surfaceMuted }]}
                >
                  <Ionicons
                    name={active ? 'cloud-done-outline' : 'cloud-outline'}
                    size={20}
                    color={active ? theme.accent : theme.textFaint}
                  />
                  <Text variant="callout" tone={active ? undefined : 'muted'} numberOfLines={1} style={{ flex: 1 }}>
                    {acct.email}
                  </Text>
                  {active && tierLabel(tier) ? (
                    <View style={[styles.tierBadge, { backgroundColor: theme.accent + '22', borderColor: theme.accent + '55' }]}>
                      <Text variant="caption" style={{ color: theme.accent, fontSize: 10, fontWeight: '600' }}>
                        {tierLabel(tier)}
                      </Text>
                    </View>
                  ) : null}
                  {busy ? (
                    <Text variant="caption" tone="faint">
                      …
                    </Text>
                  ) : active ? (
                    <Ionicons name="checkmark" size={18} color={theme.accent} />
                  ) : (
                    <PressableScale onPress={() => setConfirmAccount(acct.email)} hitSlop={10}>
                      <Ionicons name="close-circle-outline" size={18} color={theme.textFaint} />
                    </PressableScale>
                  )}
                </PressableScale>
              );
            })}

            <PressableScale
              onPress={() => {
                onClose();
                setTimeout(() => router.push('/login'), 80);
              }}
              haptic
              scaleTo={0.98}
              style={styles.row}
            >
              <Ionicons name="add-circle-outline" size={20} color={theme.accent} />
              <Text variant="callout" style={{ color: theme.accent }}>
                {t('account.add')}
              </Text>
            </PressableScale>
          </ScrollView>
        </View>
      </View>

      <ConfirmModal
        open={!!confirmAccount}
        title={t('account.removeConfirmTitle')}
        body={confirmAccount ? t('account.removeConfirmBody', { email: confirmAccount }) : undefined}
        confirmText={t('account.remove')}
        cancelText={t('common.cancel')}
        destructive
        onConfirm={() => {
          const email = confirmAccount;
          setConfirmAccount(null);
          if (email) void removeAccount(email);
        }}
        onCancel={() => setConfirmAccount(null)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0008' },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
  },
  grabber: { alignItems: 'center', paddingVertical: spacing.sm },
  grabberBar: { width: 36, height: 4, borderRadius: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  tierBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
