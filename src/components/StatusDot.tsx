import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/src/theme';

type Props = {
  tone?: 'ok' | 'warn' | 'danger' | 'muted';
  pulse?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

export function StatusDot({ tone = 'ok', pulse = false, size = 8, style }: Props) {
  const theme = useTheme();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (!pulse) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(withTiming(0.35, { duration: 700 }), withTiming(1, { duration: 700 })),
      -1,
      true,
    );
  }, [pulse, opacity]);

  const color =
    tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'danger' ? theme.danger : theme.textFaint;

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        animatedStyle,
        style,
      ]}
    >
      <View />
    </Animated.View>
  );
}
