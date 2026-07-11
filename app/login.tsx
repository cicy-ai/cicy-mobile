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
  pollForSession,
  randomState,
  requestEmailLogin,
} from '@/src/api/cloudAuth';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { radius, spacing, type as typeScale, useTheme } from '@/src/theme';

const RESEND_COOLDOWN_S = 60;

// cicy-cloud email magic-link login — the cloud-first front door (QR scan is
// the secondary path at the bottom). Top-aligned form so the keyboard never
// covers the input; the post-send state is a full "check your inbox" screen
// with a resend cooldown. The link can be opened on ANY device; we just poll
// until the cloud has minted a session, then land in the built-in default team.
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
  // Bump to cancel an in-flight poll loop (retry / change-email / unmount).
  const attemptRef = useRef(0);
  useEffect(() => () => { attemptRef.current += 1; }, []);

  // Resend cooldown while waiting.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

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
    setCooldown(RESEND_COOLDOWN_S);
    const outcome = await pollForSession(state, () => attemptRef.current !== attempt);
    if (attemptRef.current !== attempt) return; // superseded
    if (!outcome.ok) {
      if (outcome.error === 'cancelled') return;
      setPhase('idle');
      setError(outcome.error === 'expired' ? t('login.expired') : t('login.timeout'));
      return;
    }
    setPhase('joining');
    try {
      await loginCloud(outcome.session);
      // Back through the index gate: no hub yet → scan one; otherwise /agents.
      router.replace('/');
    } catch (e: any) {
      setPhase('idle');
      setError(String(e?.message ?? e));
    }
  };

  const backToEmail = () => {
    attemptRef.current += 1; // stops the poll
    setPhase('idle');
    setError(null);
  };

  const waiting = phase === 'waiting' || phase === 'joining';

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
          /* ── Check-your-inbox screen ── */
          <View style={styles.form}>
            <View style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
              <Ionicons name="mail-unread-outline" size={30} color={theme.accent} />
            </View>
            <Text variant="title" style={styles.title}>
              {phase === 'joining' ? t('login.joiningTitle') : t('login.sentTitle')}
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
                <View style={[styles.stepsBox, styles.steps, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  {[t('login.step1'), t('login.step2'), t('login.step3')].map((step, i) => (
                    <View key={step} style={styles.stepRow}>
                      <View style={[styles.stepDot, { backgroundColor: theme.surfaceMuted }]}>
                        <Text variant="caption" tone="muted">{i + 1}</Text>
                      </View>
                      <Text variant="callout" tone="muted" style={{ flex: 1 }}>
                        {step}
                      </Text>
                    </View>
                  ))}
                </View>
                {/* waiting spinner on its own centered line, not inline with text */}
                <ActivityIndicator color={theme.textMuted} style={styles.waitSpinner} />
              </>
            )}

            {phase === 'waiting' && (
              <>
                <Button
                  title={cooldown > 0 ? t('login.resendIn', { s: cooldown }) : t('login.resend')}
                  variant="secondary"
                  onPress={() => void start()}
                  disabled={cooldown > 0}
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

            {/* Secondary path — join a self-hosted team by QR instead. */}
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
  steps: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
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
  waitSpinner: {
    marginBottom: spacing.xl,
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
