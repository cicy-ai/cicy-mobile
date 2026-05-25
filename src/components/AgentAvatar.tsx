import { Image, StyleSheet, View, type ViewStyle } from 'react-native';

import { getAgentTypeIconMeta } from '@/src/lib/agentType';
import { Text } from './Text';
import { useTheme } from '@/src/theme';

type Props = {
  agentType?: string;
  /** Used when no logo matches — first letter goes in the fallback bubble. */
  title: string;
  size?: number;
  /** Subtle border that helps the icon read against tinted card backgrounds. */
  bordered?: boolean;
  style?: ViewStyle;
};

export function AgentAvatar({ agentType, title, size = 40, bordered = true, style }: Props) {
  const theme = useTheme();
  const meta = getAgentTypeIconMeta(agentType);
  const radius = size * 0.32;
  const baseStyle: ViewStyle = {
    width: size,
    height: size,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: theme.surfaceMuted,
    borderWidth: bordered ? StyleSheet.hairlineWidth : 0,
    borderColor: theme.border,
  };

  if (meta?.src) {
    // Inset the image inside the rounded square — visually matches cicy-code's
    // AgentAvatar where the logo sits on the tile rather than filling it.
    const pad = Math.max(4, Math.round(size * 0.18));
    return (
      <View style={[baseStyle, style]}>
        <Image
          source={meta.src}
          style={{ width: size - pad * 2, height: size - pad * 2 }}
          resizeMode="contain"
        />
      </View>
    );
  }

  // Text-only icon (e.g. 🦞 for openclaw, "HE" for hermes) or fallback letter.
  const text = meta?.text || (title.trim().slice(0, 1) || '?').toUpperCase();
  // Emoji + 2-letter codes need a slightly different size envelope.
  const isShortCode = /^[A-Z]{1,3}$/.test(text);
  const fontSize = isShortCode ? size * 0.34 : size * 0.5;

  return (
    <View style={[baseStyle, style]}>
      <Text
        style={{
          fontSize,
          lineHeight: fontSize + 2,
          fontWeight: isShortCode ? '700' : '500',
          color: theme.text,
          letterSpacing: isShortCode ? 0.5 : 0,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
