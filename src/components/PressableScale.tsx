// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { Platform, Pressable, type PressableProps } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const IS_WEB = Platform.OS === 'web';
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = PressableProps & {
  haptic?: boolean | Haptics.ImpactFeedbackStyle;
  scaleTo?: number;
};

export function PressableScale({
  haptic = true,
  scaleTo = 0.97,
  onPressIn,
  onPressOut,
  onPress,
  style,
  ...rest
}: Props) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handleIn = useCallback(
    (e: any) => {
      if (!IS_WEB) scale.value = withTiming(scaleTo, { duration: 90 });
      onPressIn?.(e);
    },
    [onPressIn, scale, scaleTo],
  );

  const handleOut = useCallback(
    (e: any) => {
      if (!IS_WEB) scale.value = withTiming(1, { duration: 120 });
      onPressOut?.(e);
    },
    [onPressOut, scale],
  );

  const handlePress = useCallback(
    (e: any) => {
      // expo-haptics throws on web — guard it.
      if (haptic && !IS_WEB) {
        const intensity =
          typeof haptic === 'boolean' ? Haptics.ImpactFeedbackStyle.Light : haptic;
        Haptics.impactAsync(intensity).catch(() => undefined);
      }
      onPress?.(e);
    },
    [haptic, onPress],
  );

  // On web, AnimatedPressable from reanimated doesn't reliably forward DOM
  // events. Use a plain Pressable there — the scale animation is a polish-only
  // detail anyway. Native still gets the animated version.
  if (IS_WEB) {
    return (
      <Pressable
        {...rest}
        onPressIn={handleIn}
        onPressOut={handleOut}
        onPress={handlePress}
        style={style}
      />
    );
  }

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={handleIn}
      onPressOut={handleOut}
      onPress={handlePress}
      style={[style as any, animatedStyle]}
    />
  );
}
