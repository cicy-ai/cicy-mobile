// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/src/theme';

// Web variant of TypingDots: pure CSS keyframe animation. react-native-web
// compiles `animationKeyframes` to a real CSS @keyframes rule, so the dots
// pulse on the compositor with zero JS per frame — no reanimated/worklets in
// the web bundle. Native keeps the reanimated version (TypingDots.tsx).
function Dot({ delay, color }: { delay: number; color: string }) {
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: color },
        {
          animationKeyframes: {
            '0%, 100%': { opacity: 0.35, transform: [{ translateY: 0 }] },
            '50%': { opacity: 1, transform: [{ translateY: -3 }] },
          },
          animationDuration: '840ms',
          animationIterationCount: 'infinite',
          animationDelay: `${delay}ms`,
          animationTimingFunction: 'ease-in-out',
        } as any,
      ]}
    />
  );
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
