// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons } from '@expo/vector-icons';
import { Image, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import i18n from '@/src/i18n';
import { spacing } from '@/src/theme';

type Src = { uri: string; headers?: Record<string, string> };

// Full-screen image viewer. Renders through <Image> WITH the asset's auth
// headers — the old tap path (Linking.openURL) dead-ended on cloud tenants
// because the external browser has no Bearer. Native gets pinch-zoom + pan +
// double-tap toggle (RNGH + reanimated, both already deps); web keeps it
// simple: tap backdrop to close, ↗ to open the raw URL.
export function ImageLightbox({
  src,
  browserUrl,
  name,
  onClose,
}: {
  src: Src;
  // Token-bearing URL the external browser can open on its own (the in-app
  // <Image> above uses src.headers; the browser has no header).
  browserUrl?: string;
  name?: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  // ── zoom/pan state (native only, but hooks must run unconditionally) ──
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const reset = (animated = true) => {
    'worklet';
    scale.value = animated ? withTiming(1) : 1;
    tx.value = animated ? withTiming(0) : 0;
    ty.value = animated ? withTiming(0) : 0;
    savedScale.value = 1;
    savedTx.value = 0;
    savedTy.value = 0;
  };
  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(6, Math.max(1, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1.02) reset();
    });
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (savedScale.value <= 1) return; // pan only while zoomed (else it fights the close tap)
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        reset();
      } else {
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
      }
    });
  const gesture = Gesture.Simultaneous(pinch, pan, doubleTap);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  const openExternal = () => Linking.openURL(browserUrl || src.uri).catch(() => {});

  const img = <Image source={src as any} style={styles.img} resizeMode="contain" />;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      {/* RNGH gotcha: a Modal is a separate native root — GestureDetector inside
          one needs its own GestureHandlerRootView or gestures silently no-op. */}
      <GestureHandlerRootView style={styles.backdrop}>
        {Platform.OS === 'web' ? (
          <Pressable style={styles.fill} onPress={onClose}>
            {img}
          </Pressable>
        ) : (
          <GestureDetector gesture={gesture}>
            <Animated.View style={[styles.fill, animStyle]}>{img}</Animated.View>
          </GestureDetector>
        )}

        <View style={[styles.topBar, { paddingTop: Math.max(insets.top, spacing.md) }]}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityLabel={i18n.t('common.close')}
            style={styles.topBtn}
          >
            <Ionicons name="close" size={22} color="#fff" />
          </Pressable>
          {name ? (
            <Text numberOfLines={1} style={styles.title}>
              {name}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <Pressable
            onPress={openExternal}
            hitSlop={12}
            accessibilityLabel={i18n.t('chat.openExternal')}
            style={styles.topBtn}
          >
            <Ionicons name="open-outline" size={20} color="#fff" />
          </Pressable>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  img: { width: '100%', height: '100%' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  topBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  title: { flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 13, textAlign: 'center' },
});
