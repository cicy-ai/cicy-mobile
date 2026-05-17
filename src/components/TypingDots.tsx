import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/src/theme';

function Dot({ delay, color }: { delay: number; color: string }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(
      delay,
      withRepeat(
        withSequence(withTiming(1, { duration: 420 }), withTiming(0, { duration: 420 })),
        -1,
        false,
      ),
    );
  }, [delay, t]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.35 + t.value * 0.65,
    transform: [{ translateY: -t.value * 3 }],
  }));
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

export function TypingDots() {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Dot delay={0} color={theme.textMuted} />
      <Dot delay={140} color={theme.textMuted} />
      <Dot delay={280} color={theme.textMuted} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
