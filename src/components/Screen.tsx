// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing } from '@/src/theme';
import { useTheme } from '@/src/theme';

type Props = ViewProps & {
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  padded?: boolean;        // applies horizontal page padding
  scrollHeader?: boolean;  // sets minimal top inset (header handles top safe area)
};

export function Screen({ children, padded, edges, scrollHeader, style, ...rest }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const resolvedEdges = edges ?? (scrollHeader ? ['left', 'right'] : ['top', 'left', 'right']);

  return (
    <SafeAreaView
      edges={resolvedEdges}
      style={[
        styles.root,
        { backgroundColor: theme.bg },
        scrollHeader && { paddingTop: insets.top * 0 },
      ]}
    >
      <View
        style={[
          styles.inner,
          padded && { paddingHorizontal: spacing.xl },
          style,
        ]}
        {...rest}
      >
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { flex: 1 },
});
