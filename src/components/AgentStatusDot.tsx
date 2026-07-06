// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';

// 状态点 — 对齐 cicy-code TeamPanel 的 team-panel-worker-metrics-status:
// working = 黄点 + ping 扩散动画;idle = 绿点;未知(首拉前)= 灰点。
const COLOR_WORKING = '#ca8a04'; // yellow-600
const COLOR_IDLE = '#047857'; // emerald-700
const COLOR_UNKNOWN = '#3f3f46'; // zinc-700

export function AgentStatusDot({ working, known = true, size = 8 }: { working: boolean; known?: boolean; size?: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!working) return;
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 1000,
        easing: Easing.out(Easing.ease),
        // web 的原生驱动是 no-op(同 TeamDrawer 的坑),用 JS 驱动。
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      anim.setValue(0);
    };
  }, [working, anim]);

  const color = known ? (working ? COLOR_WORKING : COLOR_IDLE) : COLOR_UNKNOWN;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {working ? (
        <Animated.View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: COLOR_WORKING,
            opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
            transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
          }}
        />
      ) : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}
