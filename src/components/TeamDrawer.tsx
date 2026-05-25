import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from './PressableScale';
import { TeamAvatar } from './TeamAvatar';
import { Text } from './Text';
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
  const teams = useAuthStore((s) => s.teams);
  const currentTeamId = useAuthStore((s) => s.currentTeamId);
  const switchTeam = useAuthStore((s) => s.switchTeam);
  const removeTeam = useAuthStore((s) => s.removeTeam);

  const tx = useRef(new Animated.Value(-DRAWER_W)).current;
  const scrimOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(tx, {
        toValue: open ? 0 : -DRAWER_W,
        duration: open ? 240 : 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(scrimOpacity, {
        toValue: open ? 0.5 : 0,
        duration: open ? 240 : 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [open, tx, scrimOpacity]);

  async function onPickTeam(team: Team) {
    if (team.id !== currentTeamId) await switchTeam(team.id);
    onClose();
  }

  function onLongPressTeam(team: Team) {
    Alert.alert(
      t('teams.removeConfirmTitle'),
      t('teams.removeConfirmBody', { title: team.title }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('teams.remove'),
          style: 'destructive',
          onPress: async () => {
            await removeTeam(team.id);
            const remaining = useAuthStore.getState().teams;
            onClose();
            if (remaining.length === 0) {
              setTimeout(() => router.replace('/scan'), 50);
            }
          },
        },
      ],
    );
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
                  onLongPress={() => onLongPressTeam(team)}
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
        </Animated.View>
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
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
});
