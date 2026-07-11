// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Animated,
  Dimensions,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Ionicons } from '@expo/vector-icons';

import { ConfirmModal } from './ConfirmModal';
import { PressableScale } from './PressableScale';
import { TeamAvatar } from './TeamAvatar';
import { Text } from './Text';
import { runningOtaLabel } from '@/src/lib/otaInfo';
import { useAuthStore, type Team } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  open: boolean;
  onClose: () => void;
};

const DRAWER_W = Math.min(320, Dimensions.get('window').width * 0.84);

// Account plan level → short display badge. Mirrors the cloud's tier names
// (personal | team | enterprise); '' / unknown → no badge.
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

export function TeamDrawer({ open, onClose }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // expoConfig.version is correct in BOTH contexts now: embedded bundles get
  // it from the release CI's sync-version, OTA bundles from the ota workflow
  // syncing to the newest v* tag before export. (SDK 55 expo-constants has NO
  // native version field — Constants.nativeApplicationVersion was a phantom
  // that read undefined; the real one lives in expo-application, a native
  // module we can't ship over the air.)
  const appVersion = Constants.expoConfig?.version ?? '';
  // Running OTA label (e.g. "u202607055") — identifies exactly which hot
  // update this session runs; empty on the APK-embedded bundle.
  const otaLabel = runningOtaLabel();
  const buildNo =
    Constants.expoConfig?.android?.versionCode ?? Constants.expoConfig?.ios?.buildNumber ?? null;
  const teams = useAuthStore((s) => s.teams);
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const switchTeam = useAuthStore((s) => s.switchTeam);
  const removeTeam = useAuthStore((s) => s.removeTeam);
  const hubs = useAuthStore((s) => s.hubs);
  const session = useAuthStore((s) => s.session);
  const userEmail = useAuthStore((s) => s.userEmail);
  const tier = useAuthStore((s) => s.tier);
  const accounts = useAuthStore((s) => s.accounts);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const [confirmAccount, setConfirmAccount] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  // Built-in default team pinned first, then cloud teams, then scanned customs
  // (each group keeps its addedAt order).
  const groupRank = (tm: Team) => (tm.builtin ? 0 : tm.kind === 'cloud' ? 1 : 2);
  const ordered = [...teams].sort((a, b) => groupRank(a) - groupRank(b) || a.addedAt - b.addedAt);

  const tx = useRef(new Animated.Value(-DRAWER_W)).current;
  const scrimOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // react-native-web has no native animation driver — useNativeDriver:true
    // there silently no-ops the transform, leaving the drawer parked off-screen
    // (the "drawer won't open" bug). Use the JS driver on web.
    const useNativeDriver = Platform.OS !== 'web';
    Animated.parallel([
      Animated.timing(tx, {
        toValue: open ? 0 : -DRAWER_W,
        duration: open ? 240 : 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver,
      }),
      Animated.timing(scrimOpacity, {
        toValue: open ? 0.5 : 0,
        duration: open ? 240 : 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver,
      }),
    ]).start();
  }, [open, tx, scrimOpacity]);

  async function onPickTeam(team: Team) {
    if (team.id !== currentTeamId) await switchTeam(team.id);
    onClose();
    // Teams are the secondary stack. Picking one from the Hub's drawer steps
    // into it; from the teams screen itself this is a no-op (already there).
    router.navigate('/agents');
  }

  // Long-press a team → in-app confirm overlay (RN-web's Alert.alert with
  // buttons is a no-op, so a real modal is the only cross-platform way).
  const [confirmTeam, setConfirmTeam] = useState<Team | null>(null);

  async function onConfirmRemove() {
    const team = confirmTeam;
    setConfirmTeam(null);
    if (!team) return;
    await removeTeam(team.id);
    const remaining = useAuthStore.getState().teams;
    onClose();
    if (remaining.length === 0) {
      setTimeout(() => router.replace('/scan'), 50);
    }
  }

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFillObject}>
        <Animated.View
          style={[StyleSheet.absoluteFillObject, { backgroundColor: '#000', opacity: scrimOpacity }]}
        >
          <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.drawer,
            {
              backgroundColor: theme.bg,
              borderRightColor: theme.border,
              paddingTop: insets.top + spacing.lg,
              paddingBottom: insets.bottom + spacing.md,
              transform: [{ translateX: tx }],
            },
          ]}
        >
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text variant="title">{t('teams.drawerTitle')}</Text>
              <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {t('teams.drawerSubtitle', { count: teams.length })}
              </Text>
            </View>
            {/* Scan-to-add lives here now (home header's right button is ⊕). */}
            <PressableScale
              onPress={() => {
                onClose();
                setTimeout(() => router.push('/scan'), 80);
              }}
              haptic
              scaleTo={0.94}
              hitSlop={8}
              style={[styles.scanBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Ionicons name="scan-outline" size={20} color={theme.text} />
            </PressableScale>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
            {/* Hubs — teams below come from them. Tap to scan and add another
                hub (the app supports several). */}
            <PressableScale
              onPress={() => {
                onClose();
                setTimeout(() => router.push('/scan'), 80);
              }}
              haptic
              scaleTo={0.97}
              style={styles.teamRow}
            >
              <View
                style={[
                  styles.hubIcon,
                  { backgroundColor: hubs.length ? theme.accent : theme.surface, borderColor: theme.border },
                ]}
              >
                <Ionicons
                  name="git-network-outline"
                  size={20}
                  color={hubs.length ? theme.accentText : theme.textMuted}
                />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="callout" numberOfLines={1}>
                  {t('hub.title')}
                </Text>
                <Text variant="caption" tone="faint" numberOfLines={1} ellipsizeMode="middle">
                  {hubs.length
                    ? t('hub.hubCount', { count: hubs.length, defaultValue: '{{count}} connected · scan to add' })
                    : t('hub.notConnected')}
                </Text>
              </View>
              <Ionicons name="add" size={18} color={theme.accent} />
            </PressableScale>

            <View style={[styles.sectionDivider, { backgroundColor: theme.border }]} />

            {ordered.map((team) => {
              return (
                <PressableScale
                  key={team.id}
                  onPress={() => onPickTeam(team)}
                  // The built-in default team can't be removed — sign out of
                  // the cloud account below instead.
                  onLongPress={team.builtin || team.kind === 'hub' ? undefined : () => setConfirmTeam(team)}
                  haptic
                  scaleTo={0.97}
                  style={styles.teamRow}
                >
                  <TeamAvatar id={team.id} title={team.title} size={40} bordered />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="callout" numberOfLines={1}>
                      {team.title}
                    </Text>
                    <Text variant="caption" tone="faint" numberOfLines={1} ellipsizeMode="middle">
                      {team.serverUrl.replace(/^https?:\/\//, '')}
                    </Text>
                  </View>
                  {team.kind === 'cloud' ? (
                    <Ionicons name="cloud-outline" size={14} color={theme.textFaint} />
                  ) : null}
                </PressableScale>
              );
            })}
          </ScrollView>

          {/* cicy-cloud accounts — every account signed in on this device.
              Tap → switch (rebuilds the team list for that account); long-press
              → remove from the device; ＋ row → email login for another one. */}
          <View style={[styles.accounts, { borderTopColor: theme.border }]}>
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
                  onLongPress={() => setConfirmAccount(acct.email)}
                  haptic
                  scaleTo={0.97}
                  style={styles.accountRow}
                >
                  <Ionicons
                    name={active ? 'cloud-done-outline' : 'cloud-outline'}
                    size={18}
                    color={active ? theme.accent : theme.textFaint}
                  />
                  <Text
                    variant="caption"
                    tone={active ? undefined : 'muted'}
                    numberOfLines={1}
                    style={{ flex: 1 }}
                  >
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
                    <Text variant="caption" tone="faint">…</Text>
                  ) : active ? (
                    <Ionicons name="checkmark" size={16} color={theme.accent} />
                  ) : null}
                </PressableScale>
              );
            })}
            <PressableScale
              onPress={() => {
                onClose();
                setTimeout(() => router.push('/login'), 80);
              }}
              haptic
              scaleTo={0.97}
              style={styles.accountRow}
            >
              <Ionicons
                name={accounts.length ? 'add-circle-outline' : 'cloud-outline'}
                size={18}
                color={theme.accent}
              />
              <Text variant="callout" style={{ color: theme.accent }}>
                {accounts.length ? t('account.add') : t('login.entry')}
              </Text>
            </PressableScale>
          </View>

          {/* 会议实录 is shelved — switch hidden on request (store kept, so
              restoring is just re-adding the row; the composer button stays
              gone because liveRecord defaults to off). */}

          {appVersion ? (
            <View style={[styles.footer, { borderTopColor: theme.border }]}>
              <Text variant="caption" tone="faint">
                {`v${appVersion}${buildNo ? ` (${buildNo})` : ''}${otaLabel ? ` · ${otaLabel}` : ''}`}
              </Text>
            </View>
          ) : null}
        </Animated.View>

        <ConfirmModal
          open={!!confirmTeam}
          title={t('teams.removeConfirmTitle')}
          body={confirmTeam ? t('teams.removeConfirmBody', { title: confirmTeam.title }) : undefined}
          confirmText={t('teams.remove')}
          cancelText={t('common.cancel')}
          destructive
          onConfirm={() => void onConfirmRemove()}
          onCancel={() => setConfirmTeam(null)}
        />

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
            if (!email) return;
            void (async () => {
              await removeAccount(email);
              const remaining = useAuthStore.getState().teams;
              if (remaining.length === 0) {
                onClose();
                setTimeout(() => router.replace('/scan'), 50);
              }
            })();
          }}
          onCancel={() => setConfirmAccount(null)}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  drawer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: DRAWER_W,
    paddingHorizontal: spacing.md,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
  },
  scanBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingVertical: spacing.xs, gap: spacing.xs },
  accounts: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  tierBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  footer: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  hubIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.md,
    opacity: 0.6,
  },
});
