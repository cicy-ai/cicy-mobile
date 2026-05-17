import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, radius, spacing, type, type ThemeShape } from './tokens';

export type Theme = ThemeShape;

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTheme : lightTheme;
}

export { radius, spacing, type };
