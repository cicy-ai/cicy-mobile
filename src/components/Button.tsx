// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { PressableScale } from './PressableScale';
import { Text } from './Text';
import { radius, spacing, useTheme } from '@/src/theme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

type Props = {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
};

export function Button({ title, onPress, variant = 'primary', loading, disabled, fullWidth = true }: Props) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const colors = (() => {
    switch (variant) {
      case 'primary':
        return { bg: theme.accent, fg: theme.accentText, border: 'transparent' };
      case 'danger':
        return { bg: theme.danger, fg: theme.accentText, border: 'transparent' };
      case 'secondary':
        return { bg: theme.surface, fg: theme.text, border: theme.borderStrong };
      case 'ghost':
        return { bg: 'transparent', fg: theme.text, border: 'transparent' };
    }
  })();

  return (
    <PressableScale
      onPress={onPress}
      disabled={isDisabled}
      haptic={!isDisabled}
      scaleTo={0.98}
      style={[
        styles.base,
        fullWidth && { alignSelf: 'stretch' },
        {
          backgroundColor: colors.bg,
          borderColor: colors.border,
          borderWidth: variant === 'secondary' ? StyleSheet.hairlineWidth : 0,
          opacity: isDisabled ? 0.55 : 1,
        },
      ]}
    >
      <View style={styles.inner}>
        {loading ? (
          <ActivityIndicator color={colors.fg} />
        ) : (
          <Text variant="bodyMedium" style={{ color: colors.fg }}>
            {title}
          </Text>
        )}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md + 2,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
