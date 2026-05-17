import { useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { Text } from './Text';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

type Props = TextInputProps & {
  label?: string;
  help?: string;
};

export function Input({ label, help, style, onFocus, onBlur, ...rest }: Props) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ gap: spacing.xs }}>
      {label ? (
        <Text variant="caption" tone="muted" style={{ marginBottom: 2 }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        placeholderTextColor={theme.textFaint}
        style={[
          styles.input,
          typeScale.body,
          {
            backgroundColor: theme.surface,
            borderColor: focused ? theme.accent : theme.border,
            color: theme.text,
          },
          style,
        ]}
      />
      {help ? (
        <Text variant="caption" tone="faint">
          {help}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 48,
  },
});
