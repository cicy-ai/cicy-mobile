// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useRef } from 'react';

import { Button } from './Button';
import { ConfirmModal } from './ConfirmModal';
import { TeamAvatar } from './TeamAvatar';
import { Text } from './Text';
import { useAuthStore, type Team } from '@/src/store/auth';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  open: boolean;
  team: Team;
  onClose: () => void;
};

export function TeamTitleModal({ open, team, onClose }: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const renameTeam = useAuthStore((s) => s.renameTeam);
  const removeTeam = useAuthStore((s) => s.removeTeam);
  const [draft, setDraft] = useState(team.title);

  // Slide-up entry — feels more rooted to the title that opened it than a
  // pure fade. We use a single Animated.Value for translate + opacity.
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: open ? 220 : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [open, anim]);

  useEffect(() => {
    if (open) setDraft(team.title);
  }, [open, team.title]);

  async function onSave() {
    const next = draft.trim();
    if (!next || next === team.title) {
      onClose();
      return;
    }
    await renameTeam(team.id, next);
    onClose();
  }

  // Remove goes through an explicit confirm overlay — never delete on a
  // single tap (and RN-web's Alert.alert with buttons is a no-op anyway).
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function onConfirmRemove() {
    setConfirmOpen(false);
    onClose();
    await removeTeam(team.id);
    // The agents screen reacts to `teams.length === 0` by rendering its empty
    // state, so no routing is needed here.
  }

  const previewTeam = { ...team, title: draft || team.title };

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.root}
      >
        <Animated.View style={[StyleSheet.absoluteFillObject, { opacity: anim }]}>
          <Pressable style={[styles.scrim]} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor: theme.surface,
              borderColor: theme.border,
              opacity: anim,
              transform: [
                {
                  translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }),
                },
              ],
            },
          ]}
        >
          {/* Drag-handle pill — purely decorative, signals "this can be dismissed" */}
          <View style={[styles.handle, { backgroundColor: theme.border }]} />

          <View style={styles.headerRow}>
            <TeamAvatar id={previewTeam.id} title={previewTeam.title} size={48} bordered />
            <View style={{ flex: 1 }}>
              <Text variant="h3">{t('teams.editTitleTitle')}</Text>
              <Text variant="caption" tone="muted" numberOfLines={1} ellipsizeMode="middle" style={{ marginTop: 2 }}>
                {team.serverUrl.replace(/^https?:\/\//, '')}
              </Text>
            </View>
          </View>

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('teams.titlePlaceholder')}
            placeholderTextColor={theme.textFaint}
            autoFocus
            selectTextOnFocus
            maxLength={48}
            style={[
              styles.input,
              { color: theme.text, backgroundColor: theme.bg, borderColor: theme.border },
            ]}
            returnKeyType="done"
            onSubmitEditing={onSave}
          />

          <View style={styles.btnRow}>
            <Button title={t('teams.remove')} variant="ghost" onPress={() => setConfirmOpen(true)} />
            <View style={{ flex: 1 }} />
            <Button title={t('common.cancel')} variant="ghost" onPress={onClose} />
            <Button title={t('common.ok')} onPress={onSave} />
          </View>
        </Animated.View>

        <ConfirmModal
          open={confirmOpen}
          title={t('teams.removeConfirmTitle')}
          body={t('teams.removeConfirmBody', { title: team.title })}
          confirmText={t('teams.remove')}
          cancelText={t('common.cancel')}
          destructive
          onConfirm={() => void onConfirmRemove()}
          onCancel={() => setConfirmOpen(false)}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  card: {
    margin: spacing.md,
    padding: spacing.lg,
    paddingTop: spacing.md,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
