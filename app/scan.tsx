import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Animated, Easing, StyleSheet, View } from 'react-native';

import { Button } from '@/src/components/Button';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { parsePayload } from '@/src/lib/parsePayload';
import { useAuthStore } from '@/src/store/auth';
import { spacing, useTheme } from '@/src/theme';

const FRAME_SIZE = 260;

export default function Scan() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const teams = useAuthStore((s) => s.teams);
  const canGoBack = teams.length > 0;
  const addTeam = useAuthStore((s) => s.addTeam);
  const [done, setDone] = useState(false);
  const handledRef = useRef(false);

  // Scanning line animation — gives the user something to look at and confirms
  // the camera is actually live.
  const scanY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!permission?.granted || done) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanY, { toValue: FRAME_SIZE - 4, duration: 1600, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(scanY, { toValue: 0, duration: 1600, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [permission?.granted, done, scanY]);

  if (!permission) {
    return (
      <Screen>
        <View style={styles.center}>
          <Text tone="muted">{t('scan.requestingPermission')}</Text>
        </View>
      </Screen>
    );
  }

  if (!permission.granted) {
    return (
      <Screen padded>
        <View style={styles.navRow}>
          {canGoBack ? (
            <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={26} color={theme.text} />
            </PressableScale>
          ) : (
            <View style={styles.backBtn} />
          )}
        </View>
        <View style={styles.center}>
          <Ionicons name="qr-code-outline" size={64} color={theme.textMuted} />
          <Text variant="title" style={{ marginTop: spacing.lg }}>{t('scan.permissionTitle')}</Text>
          <Text tone="muted" style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {t('scan.permissionBody')}
          </Text>
          <View style={{ height: spacing.xl }} />
          <Button title={t('scan.grantPermission')} onPress={requestPermission} />
        </View>
      </Screen>
    );
  }

  async function onBarcode(raw: string) {
    if (handledRef.current) return;
    handledRef.current = true;
    const parsed = parsePayload(raw);
    if (!parsed || !parsed.server || !parsed.token) {
      // QR must contain BOTH server URL and token to add a team — there's no
      // notion of "partial creds" anymore now that we've removed manual entry.
      Alert.alert(t('scan.invalidTitle'), t('scan.invalidBody', { raw: raw.slice(0, 80) }), [
        { text: t('common.tryAgain'), onPress: () => { handledRef.current = false; } },
      ]);
      return;
    }
    try {
      // Store exactly what was scanned — the QR carries the team server's own
      // public HTTPS address (cicy-code's CICY_PUBLIC_URL).
      await addTeam({ serverUrl: parsed.server, token: parsed.token, title: parsed.title });
      setDone(true);
      setTimeout(() => router.replace('/agents'), 600);
    } catch (e: any) {
      Alert.alert(t('scan.errorTitle'), String(e?.message ?? e));
      handledRef.current = false;
    }
  }

  return (
    <Screen edges={['top', 'left', 'right']}>
      {/* Top nav — back button + page title */}
      <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
        {canGoBack ? (
          <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={26} color={theme.text} />
          </PressableScale>
        ) : (
          // No history to go back to (first launch). Reserve the slot so the
          // title stays at the same x-offset as the case with a back button.
          <View style={styles.backBtn} />
        )}
        <Text variant="h3" style={{ flex: 1 }}>
          {t('scan.title')}
        </Text>
      </View>

      {/* Subtitle / explanation right below the title */}
      <View style={styles.subtitleWrap}>
        <Text tone="muted" variant="callout" style={{ textAlign: 'center' }}>
          {t('scan.subtitle')}
        </Text>
      </View>

      {/* Camera + frame */}
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(e) => onBarcode(e.data)}
        />
        {/* Dim overlay everywhere except the frame */}
        <View style={styles.overlay} pointerEvents="none" />
        <View style={styles.frameWrap} pointerEvents="none">
          <View style={[styles.frameBox, { borderColor: done ? theme.accent : '#fff' }]}>
            {/* Corner ticks for that classic scanner look */}
            <View style={[styles.corner, styles.cornerTL, { borderColor: theme.accent }]} />
            <View style={[styles.corner, styles.cornerTR, { borderColor: theme.accent }]} />
            <View style={[styles.corner, styles.cornerBL, { borderColor: theme.accent }]} />
            <View style={[styles.corner, styles.cornerBR, { borderColor: theme.accent }]} />
            {/* Animated scan line */}
            {!done && (
              <Animated.View
                style={[styles.scanLine, { backgroundColor: theme.accent, transform: [{ translateY: scanY }] }]}
              />
            )}
          </View>
        </View>
      </View>

      {/* Bottom info card — explains where to find the QR */}
      <View style={[styles.infoCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={styles.infoRow}>
          <View style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
            <Ionicons name="laptop-outline" size={18} color={theme.text} />
          </View>
          <Text variant="callout" style={{ flex: 1 }}>
            {t('scan.stepOpenWeb')}
          </Text>
        </View>
        <View style={[styles.divider, { backgroundColor: theme.border }]} />
        <View style={styles.infoRow}>
          <View style={[styles.iconCircle, { backgroundColor: theme.surfaceMuted }]}>
            <Ionicons name="qr-code-outline" size={18} color={theme.text} />
          </View>
          <Text variant="callout" style={{ flex: 1 }}>
            {t('scan.stepShowQr')}
          </Text>
        </View>
        <View style={[styles.divider, { backgroundColor: theme.border }]} />
        <View style={styles.infoRow}>
          <View style={[styles.iconCircle, { backgroundColor: theme.accent }]}>
            <Ionicons name="scan-outline" size={18} color={theme.accentText} />
          </View>
          <Text variant="callout" style={{ flex: 1, color: done ? theme.accent : theme.text }}>
            {done ? t('scan.successHint') : t('scan.stepAimHere')}
          </Text>
        </View>
      </View>

      {/* cicy-cloud login — the zero-QR path to the built-in default team. */}
      <PressableScale
        onPress={() => router.push('/login')}
        haptic
        scaleTo={0.97}
        style={styles.loginEntry}
      >
        <Ionicons name="cloud-outline" size={16} color={theme.accent} />
        <Text variant="callout" style={{ color: theme.accent }}>
          {t('login.entry')}
        </Text>
      </PressableScale>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  loginEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.sm,
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  subtitleWrap: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  cameraWrap: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  frameWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameBox: {
    width: FRAME_SIZE,
    height: FRAME_SIZE,
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#fff',
  },
  cornerTL: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 18 },
  cornerTR: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 18 },
  cornerBL: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 18 },
  cornerBR: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 18 },
  scanLine: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 2,
    borderRadius: 2,
    opacity: 0.85,
  },
  infoCard: {
    margin: spacing.lg,
    padding: spacing.lg,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 32 + spacing.md,
  },
});
