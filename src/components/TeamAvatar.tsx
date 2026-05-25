import { StyleSheet, View, type ViewStyle } from 'react-native';

import { teamAvatarColor, teamInitial } from '@/src/lib/teamAvatar';
import { Text } from './Text';

type Props = {
  id: string;
  title: string;
  size?: number;
  /** When false, render a borderless flat circle. Default: subtle border for surface contrast. */
  bordered?: boolean;
  style?: ViewStyle;
};

export function TeamAvatar({ id, title, size = 36, bordered, style }: Props) {
  const color = teamAvatarColor(id);
  const fontSize = Math.max(12, Math.round(size * 0.42));
  return (
    <View
      style={[
        styles.root,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          borderWidth: bordered ? StyleSheet.hairlineWidth : 0,
          borderColor: 'rgba(0,0,0,0.08)',
        },
        style,
      ]}
    >
      <Text style={{ color: '#fff', fontWeight: '700', fontSize, lineHeight: fontSize + 2 }}>
        {teamInitial(title)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
});
