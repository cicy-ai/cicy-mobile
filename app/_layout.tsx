// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as NavigationBar from 'expo-navigation-bar';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';
import '@/src/lib/reanimatedInit';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useColorScheme } from 'react-native';
import { HubConnector } from '@/src/components/HubConnector';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { darkTheme, lightTheme } from '@/src/theme/tokens';
import { useAuthStore } from '@/src/store/auth';
import { initWebApp } from '@/src/lib/telegram';
// Side-effect import: configures i18next with the device locale before any
// screen renders. Must come after expo-localization (which getDeviceLocale
// imports) is available.
import '@/src/i18n';

// Keep the native splash visible until our auth store has hydrated and the
// first real screen is ready to render. Without this expo-splash-screen would
// auto-hide the moment _any_ view mounts, including the empty placeholder we
// return below — causing a flash of theme background before navigation kicks in.
SplashScreen.preventAutoHideAsync().catch(() => {
  /* already prevented or expo-splash-screen unavailable */
});

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);

  const isDark = colorScheme === 'dark';
  const t = isDark ? darkTheme : lightTheme;

  const navTheme = useMemo(() => {
    const base = isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: t.bg,
        card: t.bg,
        text: t.text,
        border: t.border,
        primary: t.accent,
      },
    };
  }, [isDark, t]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Web: the boot splash is dismissed by the first screen once it has real
  // content (one continuous loading instead of spinner relays) — this is only
  // the safety net so it can never stick forever.
  useEffect(() => {
    const t = setTimeout(dismissBootSplash, 8000);
    return () => clearTimeout(t);
  }, []);

  // If we're inside Telegram, signal ready + request full height. No-op in a
  // plain browser / native app.
  useEffect(() => {
    initWebApp();
  }, []);

  // Once auth has hydrated we know which initial screen expo-router will pick,
  // so it's safe to dismiss the native splash. Doing it any earlier would
  // briefly show a blank theme-bg view before navigation routes us anywhere.
  useEffect(() => {
    if (hydrated) {
      SplashScreen.hideAsync().catch(() => {
        /* already hidden */
      });
    }
  }, [hydrated]);

  // Paint the Android window background. In Expo Go this can't reach the
  // status bar area (the OS paints its own black scrim there), but it does
  // ensure the rest of the window — including the bottom navigation gap —
  // matches the theme.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(t.bg).catch(() => {});
  }, [t.bg]);

  // In edge-to-edge mode (forced on by Expo Go), the system nav bar's
  // BACKGROUND color cannot be set from JS — `setBackgroundColorAsync`
  // logs a "not supported" warning and is a no-op. The only thing we can
  // control is the icon (button) style. By picking the button style to
  // contrast with theme.bg, the OS auto-picks a matching bar-bg via the
  // windowLightNavigationBar flag, which gets us as close as Expo Go
  // allows without a dev build.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    NavigationBar.setButtonStyleAsync(isDark ? 'light' : 'dark').catch(() => {});
  }, [isDark]);

  if (!hydrated) {
    // Render a theme-coloured placeholder. Returning `null` here used to
    // prevent the root view from mounting, which kept the native splash on
    // screen forever because expo-splash-screen waits for *something* to
    // appear before it auto-hides.
    return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <SafeAreaProvider>
      <ThemeProvider value={navTheme}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.bg },
            headerShadowVisible: false,
            headerTintColor: t.text,
            headerTitleStyle: { fontWeight: '600' },
            contentStyle: { backgroundColor: t.bg },
            // Match icon color to the theme. SystemUI.setBackgroundColorAsync
            // already paints the Android window bg with theme.bg, so the
            // status bar shows that color (no scrim to fight with anymore
            // now that we no longer wedge Stack headers under it for every
            // route). Light theme → dark icons; dark theme → light icons.

            // `navigationBarColor` is silently ignored in edge-to-edge mode
            // (which Expo Go forces on). We can't set it from JS at all.
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="agents" options={{ headerShown: false }} />
          {/* Chat draws its own header — letting Stack render one re-introduces
              react-native-screens' automatic bottom safe-area padding, which
              shows up as a cream strip below the composer. */}
          <Stack.Screen name="chat/[agentId]" options={{ headerShown: false }} />
          {/* Terminal draws its own nav row — same reason as chat. */}
          <Stack.Screen name="terminal/[agentId]" options={{ headerShown: false }} />
          {/* Scan draws its own nav row — same reason as chat. */}
          <Stack.Screen name="scan" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          {/* Hub — draws its own nav row (directory + big chat). */}
          <Stack.Screen name="hub" options={{ headerShown: false }} />
        </Stack>
        {/* Translucent — SystemUI paints theme.bg behind. Icon color tracks
            the active theme so it stays readable against that bg. */}
        <StatusBar style={isDark ? 'light' : 'dark'} />
        {/* Root-mounted: keeps a WS per connected hub alive across all screens,
            feeding the team list. Renders nothing. */}
        <HubConnector />
      </ThemeProvider>
    </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
