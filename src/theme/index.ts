// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, radius, spacing, type, type ThemeShape } from './tokens';

export type Theme = ThemeShape;

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTheme : lightTheme;
}

export { radius, spacing, type };
