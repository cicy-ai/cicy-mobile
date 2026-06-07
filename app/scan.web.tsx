import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { parsePayload } from '@/src/lib/parsePayload';
import { canScanQr, scanQr } from '@/src/lib/telegram';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

// Web add-team. Inside Telegram we use the native QR scanner (showScanQrPopup);
// everywhere else there's no reliable in-browser scanner, so the user pastes the
// QR payload / cicy://addTeam link / http(s)?flag=addTeam URL. Both feed the same
// parser + addTeam path the native camera flow uses.
export default function ScanWeb() {
  const { t } = useTranslation();
  const theme = useTheme();
  const teams = useAuthStore((s) => s.teams);
  const canGoBack = teams.length > 0;
  const addTeam = useAuthStore((s) => s.addTeam);

  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasScanner = canScanQr();

  // Shared join: parse a payload (scanned or pasted) → add the team → go.
  async function join(raw: string) {
    setError(null);
    const parsed = parsePayload(raw);
    if (!parsed || !parsed.server || !parsed.token) {
      setError(t('scan.invalidBody', { raw: raw.slice(0, 80) }));
      return;
    }
    setBusy(true);
    try {
      // Store exactly what was scanned. The QR carries the team server's own
      // public HTTPS address (cicy-code's CICY_PUBLIC_URL) — the server, not
      // the client, is the source of truth for how to reach it.
      await addTeam({ serverUrl: parsed.server, token: parsed.token, title: parsed.title });
      router.replace('/agents');
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  }

  async function onScan() {
    const text = await scanQr(t('scan.subtitle'));
    if (text) await join(text);
  }

  return (
    <Screen padded edges={['top', 'left', 'right']}>
      <View style={styles.navRow}>
        {canGoBack ? (
          <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={26} color={theme.text} />
          </PressableScale>
        ) : (
          <View style={styles.backBtn} />
        )}
        <Text variant="h3" style={{ flex: 1 }}>
          {t('scan.title')}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
          <Ionicons name="qr-code-outline" size={28} color={theme.text} />
        </View>
        <Text tone="muted" variant="callout" style={{ textAlign: 'center', marginTop: spacing.md }}>
          {t('scan.subtitle')}
        </Text>

        {/* Telegram: native scanner first. */}
        {hasScanner ? (
          <>
            <View style={{ height: spacing.xl }} />
            <Button title={t('scan.scanQr', { defaultValue: 'Scan QR code' })} onPress={onScan} disabled={busy} />
            <View style={styles.divider}>
              <View style={[styles.line, { backgroundColor: theme.border }]} />
              <Text variant="caption" tone="faint" style={{ marginHorizontal: spacing.md }}>
                {t('scan.or', { defaultValue: 'or' })}
              </Text>
              <View style={[styles.line, { backgroundColor: theme.border }]} />
            </View>
          </>
        ) : (
          <View style={{ height: spacing.xl }} />
        )}

        {/* Paste fallback (always available). */}
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={t('scan.pastePlaceholder')}
          placeholderTextColor={theme.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[
            styles.input,
            typeScale.body,
            { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
          ]}
        />

        {error ? (
          <Text variant="caption" tone="danger" style={{ marginTop: spacing.sm }}>
            {error}
          </Text>
        ) : null}

        <View style={{ height: spacing.lg }} />
        <Button
          title={t('scan.addManual', { defaultValue: 'Add' })}
          onPress={() => join(value)}
          disabled={busy || !value.trim()}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginVertical: spacing.lg,
  },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  input: {
    width: '100%',
    minHeight: 96,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    textAlignVertical: 'top',
  },
});
