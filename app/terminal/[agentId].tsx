import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AgentAvatar } from '@/src/components/AgentAvatar';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { TerminalView } from '@/src/components/TerminalView';
import { Text } from '@/src/components/Text';
import { isTelegram, showBackButton } from '@/src/lib/telegram';
import { useAuthStore } from '@/src/store/auth';
import { spacing, useTheme } from '@/src/theme';

// Full-screen live terminal (the team server's gotty page for this agent's
// pane). Opened from the chat header's terminal button — non-cicy agents only,
// cicy agents run headless with no pane to attach to.
export default function Terminal() {
  const { t } = useTranslation();
  const theme = useTheme();
  const params = useLocalSearchParams<{ agentId: string; title?: string; agentType?: string }>();
  const agentId = String(params.agentId);
  const displayTitle = params.title || agentId;
  const { serverUrl, token } = useAuthStore();

  const inTg = isTelegram();
  useEffect(() => {
    if (!inTg) return;
    return showBackButton(() => router.back());
  }, [inTg]);

  const url = useMemo(() => {
    if (!serverUrl || !token || !agentId) return null;
    return `${serverUrl}/ttyd/${encodeURIComponent(agentId)}/?token=${encodeURIComponent(token)}&mode=1`;
  }, [serverUrl, token, agentId]);

  return (
    <Screen>
      {!inTg && (
        <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
          <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn} hitSlop={6}>
            <Ionicons name="chevron-back" size={26} color={theme.text} />
          </PressableScale>
          <AgentAvatar agentType={params.agentType} title={displayTitle} size={32} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyMedium" numberOfLines={1}>
              {displayTitle}
            </Text>
            <Text variant="caption" tone="faint">
              {t('chat.terminalTitle')}
            </Text>
          </View>
        </View>
      )}

      {/* Deliberately NO KeyboardAvoidingView: shrinking the webview for the
          IME makes gotty refit xterm and resize the shared tmux window — the
          desktop terminal reflows and TUI content is lost. The terminal stays
          frozen at its desktop-like size (see TerminalView) and the keyboard
          simply overlays it; pinch-zoom/pan to read while typing. */}
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {url ? (
          <TerminalView url={url} />
        ) : (
          <View style={styles.loading}>
            <Text tone="muted">{t('chat.missingCreds')}</Text>
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.xs,
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
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
