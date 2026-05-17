// Design tokens — single source of truth for the entire app.
// Tone: warm, restrained, refined. Inspired by Claude mobile.

const palette = {
  // Warm neutrals — paper-like in light, deep warm gray in dark.
  cream50: '#FAF9F5',
  cream100: '#F5F4EF',
  cream200: '#EBE9E2',
  cream300: '#D9D7CE',
  cream400: '#B3B0A4',

  ink900: '#1A1915',
  ink800: '#262522',
  ink700: '#3A3936',
  ink600: '#5A5853',
  ink500: '#8C8A82',
  ink400: '#B3B0A4',

  // Warm coffee accent (Claude-esque).
  accent500: '#C96342',
  accent600: '#B65334',
  accent200: '#EFC8B6',
  accent50: '#FBEFE7',

  // Status — muted, not loud.
  ok500: '#5C8C5C',
  warn500: '#C99A3D',
  danger500: '#B5483A',

  black: '#000',
  white: '#fff',
  transparent: 'transparent',
};

type Theme = {
  bg: string;            // page background
  surface: string;       // raised card / composer pill
  surfaceMuted: string;  // user bubble, very subtle row hover
  border: string;        // separators
  borderStrong: string;  // input borders
  text: string;          // primary text
  textMuted: string;     // secondary
  textFaint: string;     // tertiary / placeholder
  accent: string;        // primary action
  accentText: string;    // text on accent
  ok: string;
  warn: string;
  danger: string;
};

export const lightTheme: Theme = {
  bg: palette.cream50,
  surface: palette.white,
  surfaceMuted: palette.cream100,
  border: palette.cream200,
  borderStrong: palette.cream300,
  text: palette.ink900,
  textMuted: palette.ink600,
  textFaint: palette.ink500,
  accent: palette.accent500,
  accentText: palette.white,
  ok: palette.ok500,
  warn: palette.warn500,
  danger: palette.danger500,
};

export const darkTheme: Theme = {
  bg: '#1A1915',
  surface: '#262522',
  surfaceMuted: '#2F2E2A',
  border: '#3A3936',
  borderStrong: '#4A4844',
  text: '#F2F1EC',
  textMuted: '#B3B0A4',
  textFaint: '#8C8A82',
  accent: palette.accent500,
  accentText: palette.white,
  ok: '#7AA77A',
  warn: '#D9B05B',
  danger: '#D26C5E',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const type = {
  // Match iOS / Android system font; refined hierarchy.
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.3 },
  h3: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.1 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  bodyMedium: { fontSize: 16, lineHeight: 24, fontWeight: '500' as const },
  callout: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const, fontFamily: 'Menlo' },
} as const;

export type ThemeShape = Theme;
export const palettes = palette;
