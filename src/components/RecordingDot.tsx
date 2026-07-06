// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

// The pulsing dot shown while recording. Extracted out of VoiceBar so the web
// build can swap in a CSS-only sibling (RecordingDot.web.tsx) and keep
// reanimated out of the web bundle. Only mounts while recording, so it always
// animates when present.
export function RecordingDot({ color, size = 8 }: { color: string; size?: number }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(withTiming(1, { duration: 700 }), withTiming(0, { duration: 700 })),
      -1,
      true,
    );
  }, [pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: 0.35 + pulse.value * 0.65 }));
  return (
    <Animated.View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        dotStyle,
      ]}
    />
  );
}
