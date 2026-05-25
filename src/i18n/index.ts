import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { getDeviceLocale } from '@/src/lib/locale';
import en from './locales/en.json';
import zh from './locales/zh.json';

// Initialise i18n once on module import. The device locale is derived from
// expo-localization (already consumed by getDeviceLocale for STT and chinese
// variant detection) so we keep one source of truth.
//
// Languages handled:
//   - "zh" → simplified or traditional, both currently mapped to the zh bundle.
//     Traditional users still get the same wording until a zh-Hant bundle exists.
//   - everything else → en bundle (fallback).
const { whisperLang } = getDeviceLocale();
const lng = whisperLang === 'zh' ? 'zh' : 'en';

void i18n.use(initReactI18next).init({
  lng,
  fallbackLng: 'en',
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  interpolation: {
    // React already escapes everything that lands in JSX, so disabling
    // i18next's own escaping avoids double-escaping placeholders like {{count}}.
    escapeValue: false,
  },
  // React Native has no compatibility issues with the default v3 plural API,
  // but pinning the JSON format keeps the locale files predictable.
  compatibilityJSON: 'v4',
});

export default i18n;
