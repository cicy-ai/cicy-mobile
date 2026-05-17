import { Text as RNText, type TextProps } from 'react-native';

import { type as typeScale, useTheme } from '@/src/theme';

type Variant = keyof typeof typeScale;
type Tone = 'default' | 'muted' | 'faint' | 'accent' | 'danger';

type Props = TextProps & {
  variant?: Variant;
  tone?: Tone;
};

export function Text({ variant = 'body', tone = 'default', style, ...rest }: Props) {
  const theme = useTheme();
  const color =
    tone === 'muted'
      ? theme.textMuted
      : tone === 'faint'
      ? theme.textFaint
      : tone === 'accent'
      ? theme.accent
      : tone === 'danger'
      ? theme.danger
      : theme.text;
  return <RNText {...rest} style={[typeScale[variant], { color }, style]} />;
}
