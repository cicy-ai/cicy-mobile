import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Text } from './Text';
import { radius, spacing, useTheme } from '@/src/theme';

type Props = {
  open: boolean;
  title: string;
  body?: string;
  confirmText: string;
  cancelText: string;
  /** Render the confirm button in the destructive (danger) style. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// Cross-platform confirm dialog rendered as an ABSOLUTE OVERLAY, not a nested
// RN Modal: RN-web's Alert.alert with buttons is a no-op, and stacking a Modal
// inside an already-open Modal (e.g. the team drawer) is flaky on Android.
// Mount it as the last child inside the host Modal/screen.
export function ConfirmModal({ open, title, body, confirmText, cancelText, destructive, onConfirm, onCancel }: Props) {
  const anim = useRef(new Animated.Value(0)).current;
  const theme = useTheme();

  useEffect(() => {
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: open ? 200 : 140,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [open, anim]);

  if (!open) return null;

  return (
    <View {...({ dataSet: { confirmModal: '1' } } as any)} style={[StyleSheet.absoluteFillObject, styles.root]}>
      <Animated.View style={[StyleSheet.absoluteFillObject, { backgroundColor: '#000', opacity: Animated.multiply(anim, 0.5) }]}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onCancel} />
      </Animated.View>
      <Animated.View
        style={[
          styles.card,
          {
            backgroundColor: theme.bg,
            borderColor: theme.border,
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          },
        ]}
      >
        <Text variant="h3">{title}</Text>
        {body ? (
          <Text tone="muted" variant="callout" style={{ marginTop: spacing.sm }}>
            {body}
          </Text>
        ) : null}
        <View style={styles.btnRow}>
          <View style={{ flex: 1 }}>
            <Button title={cancelText} variant="secondary" onPress={onCancel} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title={confirmText} variant={destructive ? 'danger' : 'primary'} onPress={onConfirm} />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    zIndex: 1000,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.xl,
  },
  btnRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
});
