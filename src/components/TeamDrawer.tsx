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
            <Text variant="title">{t('teams.drawerTitle')}</Text>
            <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {t('teams.drawerSubtitle', { count: teams.length })}
            </Text>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.list}>
            {teams.map((team) => {
              return (
                <PressableScale
                  key={team.id}
                  onPress={() => onPickTeam(team)}
                  onLongPress={() => setConfirmTeam(team)}
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
                </PressableScale>
              );
            })}
          </ScrollView>

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
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.lg,
  },
  list: { paddingVertical: spacing.xs, gap: spacing.xs },
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
});
