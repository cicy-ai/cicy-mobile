import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type CicyCodeConnection = {
  baseUrl: string;
  token: string;
  running: boolean;
  home: string;
  accessibilityEnabled: boolean;
  mobileBridgeRunning: boolean;
};

type NativeCicyCode = {
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  getConnection(): Promise<CicyCodeConnection>;
  isAccessibilityEnabled(): Promise<boolean>;
  openAccessibilitySettings(): Promise<boolean>;
};

const native: NativeCicyCode | undefined = Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeCicyCode>('CicyCode') ?? undefined
  : undefined;

function requireAndroidRuntime(): NativeCicyCode {
  if (Platform.OS !== 'android' || !native) {
    throw new Error('The embedded cicy-code runtime is only available in the Android native build.');
  }
  return native;
}

export const cicyCode = {
  available: Platform.OS === 'android' && !!native,
  start: () => requireAndroidRuntime().start(),
  stop: () => requireAndroidRuntime().stop(),
  getConnection: () => requireAndroidRuntime().getConnection(),
  isAccessibilityEnabled: () => requireAndroidRuntime().isAccessibilityEnabled(),
  openAccessibilitySettings: () => requireAndroidRuntime().openAccessibilitySettings(),
};
