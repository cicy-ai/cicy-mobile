import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as NavigationBar from 'expo-navigation-bar';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme } from '@/src/theme/tokens';
import { useAuthStore } from '@/src/store/auth';

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

  if (!hydrated) return null;

  return (
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
            statusBarStyle: isDark ? 'light' : 'dark',
            statusBarTranslucent: true,
            statusBarBackgroundColor: 'transparent',
            // `navigationBarColor` is silently ignored in edge-to-edge mode
            // (which Expo Go forces on). We can't set it from JS at all.
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ title: '' }} />
          <Stack.Screen name="agents" options={{ headerShown: false }} />
          {/* Chat draws its own header — letting Stack render one re-introduces
              react-native-screens' automatic bottom safe-area padding, which
              shows up as a cream strip below the composer. */}
          <Stack.Screen name="chat/[agentId]" options={{ headerShown: false }} />
        </Stack>
        {/* Translucent — SystemUI paints theme.bg behind. Icon color tracks
            the active theme so it stays readable against that bg. */}
        <StatusBar style={isDark ? 'light' : 'dark'} translucent backgroundColor="transparent" />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
