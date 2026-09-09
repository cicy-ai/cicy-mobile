// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import {
  isValidEmail,
  pollLogin,
  startLogin,
  submitCode,
  type HubError,
} from '@/src/api/hubAuth';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

const RESEND_COOLDOWN_S = 60;

// CiCy Hub email sign-in — the front door. One email; the hub mails a 6-digit
// code (and a magic link). Type the code here, or open the link on any device:
// either way we poll until the hub hands over the token, then land on the
// machine list. QR scan of a self-hosted node stays as the secondary path.
export default function Login() {
  const { t } = useTranslation();
  const theme = useTheme();
  const teams = useAuthStore((s) => s.teams);
  const session = useAuthStore((s) => s.session);
  const loginHub = useAuthStore((s) => s.loginHub);
  const canGoBack = teams.length > 0 || !!session;

  useEffect(() => {
    dismissBootSplash();
  }, []);

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'code' | 'verifying' | 'joining'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Bump to cancel an in-flight poll loop (retry / change-email / unmount).
  const attemptRef = useRef(0);
  const stateRef = useRef<string | null>(null);
  const kickRef = useRef<{ wake: () => void }>({ wake: () => {} });
  useEffect(() => () => { attemptRef.current += 1; }, []);

  // Resend cooldown while waiting.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const hubErrText = (e: any): string => {
    const c = String((e as HubError)?.code || e?.message || e);
    switch (c) {
      case 'invalid_email':
        return t('login.invalidEmail');
      case 'invalid_code':
        return t('login.codeInvalid');
      case 'rate_limited':
        return t('login.rateLimited');
      case 'mail_failed':
        return t('login.mailFailed');
      case 'name_taken':
        return t('login.nameTaken');
      case 'expired':
        return t('login.expired');
      case 'timeout':
        return t('login.timeout');
      default:
        return t('login.requestFailed', { error: c });
    }
  };

  const start = async () => {
    const addr = email.trim().toLowerCase();
    if (!isValidEmail(addr)) {
      setError(t('login.invalidEmail'));
      return;
    }
    setError(null);
    setCode('');
    setPhase('sending');
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    let state: string;
    try {
      state = (await startLogin(addr)).state;
    } catch (e: any) {
      if (attemptRef.current !== attempt) return;
      setPhase('idle');
      setError(hubErrText(e));
      return;
    }
    if (attemptRef.current !== attempt) return;
    stateRef.current = state;
    setPhase('code');
    setCooldown(RESEND_COOLDOWN_S);
    const outcome = await pollLogin(state, () => attemptRef.current !== attempt, kickRef.current);
    if (attemptRef.current !== attempt) return; // superseded
    if (!outcome.ok) {
      if (outcome.error === 'cancelled') return;
      setPhase('idle');
      setError(outcome.error === 'expired' ? t('login.expired') : t('login.timeout'));
      return;
    }
    setPhase('joining');
    try {
      await loginHub(outcome.session);
      // Through the index gate → the machine list.
      router.replace('/');
    } catch (e: any) {
      setPhase('idle');
      setError(String(e?.message ?? e));
    }
  };

  const verify = async () => {
    const c = code.replace(/\D/g, '');
    const state = stateRef.current;
    if (c.length !== 6 || !state) {
      setError(t('login.codeInvalid'));
      return;
    }
    setError(null);
    setPhase('verifying');
    try {
      await submitCode(state, c);
      // Approved → wake the poll loop so it picks the token up right away.
      kickRef.current.wake();
    } catch (e: any) {
      setPhase('code');
      setError(hubErrText(e));
    }
  };

  const backToEmail = () => {
    attemptRef.current += 1; // stops the poll
    stateRef.current = null;
    setPhase('idle');
    setCode('');
    setError(null);
  };

  const waiting = phase === 'code' || phase === 'verifying' || phase === 'joining';

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
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        {waiting ? (
          /* ── Code entry (the mail link works too) ── */
          <View style={styles.form}>
            <View style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
              <Ionicons name="mail-unread-outline" size={30} color={theme.accent} />
            </View>
            <Text variant="title" style={styles.title}>
              {phase === 'joining' ? t('login.joiningTitle') : t('login.codeTitle')}
            </Text>
            <Text variant="bodyMedium" style={[styles.emailEcho, { color: theme.accent }]}>
              {email.trim()}
            </Text>

            {phase === 'joining' ? (
              <View style={styles.stepsBox}>
                <ActivityIndicator color={theme.textMuted} />
              </View>
            ) : (
              <>
                <Text tone="muted" variant="callout" style={styles.subtitle}>
                  {t('login.codeHint')}
                </Text>
                <TextInput
                  value={code}
                  onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  placeholderTextColor={theme.textFaint}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  returnKeyType="go"
                  onSubmitEditing={() => void verify()}
                  editable={phase === 'code'}
                  style={[
                    styles.input,
                    styles.codeInput,
                    { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
                  ]}
                />
                {error ? (
                  <Text variant="caption" tone="danger" style={styles.errorText}>
                    {error}
                  </Text>
                ) : null}
                <View style={{ height: spacing.lg }} />
                <Button
                  title={t('login.verify')}
                  onPress={() => void verify()}
                  loading={phase === 'verifying'}
                  disabled={phase !== 'code' || code.length !== 6}
                />
                <Text variant="caption" tone="faint" style={styles.mechanicsHint}>
                  {t('login.linkAlsoWorks')}
                </Text>
                <View style={{ height: spacing.lg }} />
                <Button
                  title={cooldown > 0 ? t('login.resendIn', { s: cooldown }) : t('login.resend')}
                  variant="secondary"
                  onPress={() => void start()}
                  disabled={cooldown > 0 || phase !== 'code'}
                />
                <PressableScale onPress={backToEmail} style={styles.plainLink} hitSlop={8}>
                  <Text variant="callout" tone="muted">
                    {t('login.changeEmail')}
                  </Text>
                </PressableScale>
              </>
            )}
          </View>
        ) : (
          /* ── Email form — top-aligned so the keyboard never covers it ── */
          <View style={styles.form}>
            <Image source={require('../assets/logos/cicy.png')} style={styles.logo} />
            <Text variant="title" style={styles.title}>
              {t('login.title')}
            </Text>
            <Text tone="muted" variant="callout" style={styles.subtitle}>
              {t('login.valueProp')}
            </Text>

            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder={t('login.emailPlaceholder')}
              placeholderTextColor={theme.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              autoFocus
              returnKeyType="go"
              onSubmitEditing={() => void start()}
              style={[
                styles.input,
                // no lineHeight: on iOS a lineHeight taller than the font pushes
                // single-line TextInput text below center
                { fontSize: typeScale.body.fontSize },
                { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            />
            {error ? (
              <Text variant="caption" tone="danger" style={styles.errorText}>
                {error}
              </Text>
            ) : null}
            <View style={{ height: spacing.lg }} />
            <Button
              title={t('login.send')}
              onPress={() => void start()}
              loading={phase === 'sending'}
              disabled={phase === 'sending' || !email.trim()}
            />
            <Text variant="caption" tone="faint" style={styles.mechanicsHint}>
              {t('login.mechanicsHint')}
            </Text>

            {/* Secondary path — join a self-hosted node by QR instead. */}
            <View style={styles.divider}>
              <View style={[styles.line, { backgroundColor: theme.border }]} />
              <Text variant="caption" tone="faint" style={{ marginHorizontal: spacing.md }}>
                {t('scan.or')}
              </Text>
              <View style={[styles.line, { backgroundColor: theme.border }]} />
            </View>
            <PressableScale
              onPress={() => (canGoBack ? router.push('/scan') : router.replace('/scan'))}
              haptic
              scaleTo={0.97}
              style={styles.scanLink}
            >
              <Ionicons name="qr-code-outline" size={16} color={theme.text} />
              <Text variant="callout">{t('login.scanInstead')}</Text>
            </PressableScale>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  form: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: 16,
    marginBottom: spacing.lg,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: { textAlign: 'center' },
  subtitle: {
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  emailEcho: {
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  stepsBox: {
    alignSelf: 'stretch',
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  plainLink: {
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  input: {
    width: '100%',
    height: 52,
    paddingHorizontal: spacing.md,
    paddingVertical: 0,
    textAlignVertical: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
  },
  codeInput: {
    fontSize: 24,
    letterSpacing: 10,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  errorText: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  mechanicsHint: {
    textAlign: 'center',
    marginTop: spacing.md,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginVertical: spacing.xl,
  },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  scanLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
});
