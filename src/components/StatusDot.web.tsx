import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/src/theme';

type Props = {
  tone?: 'ok' | 'warn' | 'danger' | 'muted';
  pulse?: boolean;
  size?: number;
  style?: StyleProp<ViewStyle>;
};

// Web variant of StatusDot: CSS-only pulse (no reanimated). Matches the native
// StatusDot.tsx visually while keeping reanimated/worklets out of the web bundle.
export function StatusDot({ tone = 'ok', pulse = false, size = 8, style }: Props) {
  const theme = useTheme();
  const color =
    tone === 'ok'
      ? theme.ok
      : tone === 'warn'
      ? theme.warn
      : tone === 'danger'
      ? theme.danger
      : theme.textFaint;

  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        pulse
          ? ({
              animationKeyframes: { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
              animationDuration: '1400ms',
              animationIterationCount: 'infinite',
              animationTimingFunction: 'ease-in-out',
            } as any)
          : null,
        style,
      ]}
    />
  );
}
