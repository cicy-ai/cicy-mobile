import { getLocales } from 'expo-localization';
import { Converter } from 'opencc-js';

const toSimplified = Converter({ from: 'hk', to: 'cn' });

type ChineseVariant = 'simplified' | 'traditional' | null;

type DeviceLocale = {
  // BCP-47 tag like "zh-Hans-CN", "en-US", "ja-JP"
  raw: string;
  // ISO 639-1 primary language code passed to Whisper: "zh", "en", "ja"...
  whisperLang: string;
  // BCP-47 for iOS/Android Speech Recognition: "zh-CN", "en-US", "ja-JP"...
  nativeSpeechLang: string;
  // For zh: 'simplified' or 'traditional' — null for non-Chinese
  chineseVariant: ChineseVariant;
};

let cached: DeviceLocale | null = null;

export function getDeviceLocale(): DeviceLocale {
  if (cached) return cached;
  const locale = getLocales()[0];
  const raw = locale?.languageTag || locale?.languageCode || 'en';
  const lower = raw.toLowerCase();
  const primary = (locale?.languageCode || raw.split('-')[0] || 'en').toLowerCase();

  let chineseVariant: ChineseVariant = null;
  if (primary === 'zh') {
    if (/zh-hant|zh-tw|zh-hk|zh-mo/.test(lower)) {
      chineseVariant = 'traditional';
    } else {
      chineseVariant = 'simplified';
    }
  }

  // Map ISO 639-1 to BCP-47 for native speech recognition
  const speechMap: Record<string, string> = {
    zh: 'zh-CN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR',
    fr: 'fr-FR', de: 'de-DE', es: 'es-ES', pt: 'pt-BR',
  };
  const nativeSpeechLang = speechMap[primary] || raw || 'en-US';

  cached = {
    raw,
    whisperLang: primary,
    nativeSpeechLang,
    chineseVariant,
  };
  return cached;
}

// Normalize a STT transcript to the device's Chinese variant. For non-Chinese
// or traditional-locale devices it returns the text unchanged.
export function normalizeChineseVariant(text: string): string {
  if (!text) return text;
  const { chineseVariant } = getDeviceLocale();
  if (chineseVariant === 'simplified') {
    try {
      return toSimplified(text);
    } catch {
      return text;
    }
  }
  return text;
}
