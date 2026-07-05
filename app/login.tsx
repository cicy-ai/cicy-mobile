import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import {
  isValidEmail,
  pollForSession,
  randomState,
  requestEmailLogin,
} from '@/src/api/cloudAuth';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

// cicy-cloud email magic-link login (device-poll — the link can be opened on
// ANY device; this screen just polls until the cloud has minted a session).
// Success synthesizes the built-in default team and lands on the agents list.
export default function Login() {
  const { t } = useTranslation();
  const theme = useTheme();
  const teams = useAuthStore((s) => s.teams);
  const loginCloud = useAuthStore((s) => s.loginCloud);
  const canGoBack = teams.length > 0;

  useEffect(() => {
    dismissBootSplash();
  }, []);

  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'waiting' | 'joining'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Bump to cancel an in-flight poll loop (retry / unmount).
  const attemptRef = useRef(0);
  useEffect(() => () => { attemptRef.current += 1; }, []);

  const start = async () => {
    const addr = email.trim();
    if (!isValidEmail(addr)) {
      setError(t('login.invalidEmail'));
      return;
    }
    setError(null);
    setPhase('sending');
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    const state = randomState();
    try {
      await requestEmailLogin(addr, state);
    } catch (e: any) {
      setPhase('idle');
      setError(t('login.requestFailed', { error: String(e?.message ?? e) }));
      return;
    }
    setPhase('waiting');
    const outcome = await pollForSession(state, () => attemptRef.current !== attempt);
    if (attemptRef.current !== attempt) return; // superseded
    if (!outcome.ok) {
      setPhase('idle');
      if (outcome.error !== 'cancelled') {
        setError(outcome.error === 'expired' ? t('login.expired') : t('login.timeout'));
      }
      return;
    }
    setPhase('joining');
    try {
      await loginCloud(outcome.session);
      router.replace('/agents');
    } catch (e: any) {
      setPhase('idle');
      setError(String(e?.message ?? e));
    }
  };

  const cancelWait = () => {
    attemptRef.current += 1;
    setPhase('idle');
  };

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
          {t('login.title')}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
          <Ionicons name="cloud-outline" size={28} color={theme.text} />
        </View>

        {phase === 'waiting' || phase === 'joining' ? (
          <>
            <Text tone="muted" variant="callout" style={styles.centerText}>
              {phase === 'joining' ? t('login.joining') : t('login.sentHint', { email: email.trim() })}
            </Text>
            <View style={{ height: spacing.xl }} />
            <ActivityIndicator color={theme.textMuted} />
            <View style={{ height: spacing.xl }} />
            <Button title={t('common.cancel')} variant="secondary" onPress={cancelWait} />
          </>
        ) : (
          <>
            <Text tone="muted" variant="callout" style={styles.centerText}>
              {t('login.subtitle')}
            </Text>
            <View style={{ height: spacing.xl }} />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder={t('login.emailPlaceholder')}
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
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
              title={t('login.send')}
              onPress={() => void start()}
              disabled={phase === 'sending' || !email.trim()}
            />
          </>
        )}
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
    marginBottom: spacing.md,
  },
  centerText: { textAlign: 'center', marginTop: spacing.md },
  input: {
    width: '100%',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
