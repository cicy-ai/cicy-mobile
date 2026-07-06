// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { View } from 'react-native';

// Web variant of RecordingDot: CSS-only pulse, no reanimated. Matches the
// native RecordingDot.tsx (opacity 0.35 ↔ 1, ~1.4s ease-in-out).
export function RecordingDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        {
          animationKeyframes: { '0%, 100%': { opacity: 0.35 }, '50%': { opacity: 1 } },
          animationDuration: '1400ms',
          animationIterationCount: 'infinite',
          animationTimingFunction: 'ease-in-out',
        } as any,
      ]}
    />
  );
}
