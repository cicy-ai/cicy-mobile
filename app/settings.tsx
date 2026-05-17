import { router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from 'react-native';

import { Button } from '@/src/components/Button';
import { Input } from '@/src/components/Input';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { spacing } from '@/src/theme';
import { useAuthStore } from '@/src/store/auth';

export default function Settings() {
  const { serverUrl: savedServer, token: savedToken, setCredentials, clear } = useAuthStore();
  const [serverUrl, setServerUrl] = useState(savedServer ?? '');
  const [token, setToken] = useState(savedToken ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const url = serverUrl.trim();
    const tok = token.trim();
    if (!url || !tok) {
      Alert.alert('Missing fields', 'Enter both server URL and token.');
      return;
    }
    if (!/^https?:\/\//.test(url)) {
      Alert.alert('Invalid URL', 'Server URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      await setCredentials(url, tok);
      router.replace('/agents');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingBottom: spacing['3xl'], paddingTop: spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ paddingTop: spacing.xl, marginBottom: spacing['2xl'] }}>
            <Text variant="display">Connect</Text>
            <Text variant="callout" tone="muted" style={{ marginTop: spacing.sm }}>
              Link this device to your cicy-code workspace.
            </Text>
          </View>

          <View style={{ gap: spacing.xl }}>
            <Input
              label="Server URL"
              value={serverUrl}
              onChangeText={setServerUrl}
              placeholder="http://192.168.1.10:8008"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              help="LAN address or tunneled domain."
            />

            <Input
              label="API Token"
              value={token}
              onChangeText={setToken}
              placeholder="cicy_…"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              help="From the cicy-code startup banner."
            />
          </View>

          <View style={{ marginTop: spacing['2xl'], gap: spacing.md }}>
            <Button title="Continue" onPress={save} loading={busy} />
            {savedToken ? (
              <Button title="Sign Out" variant="ghost" onPress={() => clear()} />
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
