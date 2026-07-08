// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AgentAvatar } from '@/src/components/AgentAvatar';
import { Composer } from '@/src/components/Composer';
import { HistoryView } from '@/src/components/HistoryView';
import { LiveRecordBar } from '@/src/components/LiveRecordBar';
import { PressableScale } from '@/src/components/PressableScale';
import { Screen } from '@/src/components/Screen';
import { Text } from '@/src/components/Text';
import { api } from '@/src/api/http';
import { uploadAttachment } from '@/src/api/upload';
import type { PendingAttachment } from '@/src/lib/attachments';
import { isHeadlessCicyAgent } from '@/src/lib/agentType';
import { isTelegram, showBackButton } from '@/src/lib/telegram';
import { dismissBootSplash } from '@/src/lib/bootSplash';
import { useAuthStore } from '@/src/store/auth';
import { useSettingsStore } from '@/src/store/settings';
import { radius, spacing, useTheme } from '@/src/theme';

// Voice input relies on native speech-recognition / audio recording, neither of
// which we wire up on web — so web defaults to (and stays in) text mode.
const IS_WEB = Platform.OS === 'web';

// Prettify a model id for the header chip / picker rows (keep it short).
function modelLabel(model?: string): string {
  const m = String(model || '').trim();
  if (!m) return '默认';
  return m
    .replace(/^deepseek-/, 'DeepSeek ')
    .replace(/^claude-/, 'Claude ')
    .replace(/-/g, ' ');
}

export default function Chat() {
  const { t } = useTranslation();
  const theme = useTheme();
  // Deep-link entry — this screen is the first content, drop the boot splash.
  useEffect(() => {
    dismissBootSplash();
  }, []);
  const {
    agentId: rawAgentId,
    title: seedTitle,
    agentType: seedType,
    machineLabel: seedMachine,
  } = useLocalSearchParams<{
    agentId: string;
    title?: string;
    agentType?: string;
    machineLabel?: string;
  }>();
  const agentId = String(rawAgentId);
  const { serverUrl, token } = useAuthStore();
  // Inside the Telegram Mini App we drop our own header and reuse Telegram's
  // native back button + title bar (saves vertical space).
  const inTg = isTelegram();
  useEffect(() => {
    if (!inTg) return;
    return showBackButton(() => router.back());
  }, [inTg]);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // Reply in flight (port of DispatcherChat's busy machine): locked on send,
  // unlocked ONLY by the hysteresis poll below on a confirmed terminal state.
  // While busy the send button becomes a STOP button, and new messages queue.
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ id: number; text: string }[]>([]);
  const queueSeqRef = useRef(1);
  const [pending, setPending] = useState<{ text: string; nonce: number } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [recording, setRecording] = useState(false);
  // Live meeting record is opt-in (settings switch in the team drawer) — the
  // button stays hidden until the user turns it on.
  const liveRecordEnabled = useSettingsStore((s) => s.liveRecord);
  // True until the first turn of a live session is sent — that first turn is
  // prefixed with a "you are a meeting assistant" instruction for the agent.
  const meetingPrimedRef = useRef(false);
  // Track keyboard visibility for the small bottom-padding bump while typing.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardShown(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardShown(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // Reset cross-agent state when switching chats.
  useEffect(() => {
    setBusy(false);
    setQueue([]);
  }, [agentId]);

  // Entering a chat whose reply is ALREADY streaming → show the stop button.
  useEffect(() => {
    let alive = true;
    api.getCurrentReply(agentId).then((r: any) => {
      if (!alive) return;
      const answerId = Number(r?.history_id || 0);
      const st = String(r?.status || '').trim().toLowerCase();
      if (answerId > 0 && !r?.complete && st !== 'failed' && st !== 'error') setBusy(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, [agentId]);

  // busy 的唯一解锁权(比 DispatcherChat 更严的基线版):第一拍先记「基线」——
  // 上一轮已完结回复的 answerId/cid。之后**只认新回合的终态**(answerId > 基线,
  // 或会话已轮换)才解锁;上一轮残留的 complete 永远不算(stdin 路径新 turn 注册
  // 要 1~3s,web 的 800ms 宽限在这里不够,实测会把第二条消息从队列漏成直发)。
  // 死锁兜底:15s 内从没见过新回合(/clear 空会话、发送被吞),解锁。
  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const since = Date.now();
    let baseline: { answerId: number; cid: string } | null = null;
    let sawNewInFlight = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const r: any = await api.getCurrentReply(agentId);
        if (cancelled) return;
        const answerId = Number(r?.history_id || 0);
        const cid = String(r?.conversation_id || '');
        const complete = !!r?.complete;
        const st = String(r?.status || '').trim().toLowerCase();
        const failed = st === 'failed' || st === 'fail' || st === 'error';
        const terminal = complete || failed;
        if (!baseline) {
          // First read. A terminal reply here is the PREVIOUS turn's leftovers →
          // it becomes the baseline. An in-flight one is already the new turn.
          baseline = terminal ? { answerId, cid } : { answerId: answerId - 1, cid };
        }
        const isNewTurn = cid !== baseline.cid || answerId > baseline.answerId;
        if (answerId > 0 && isNewTurn && !terminal) sawNewInFlight = true;
        if (answerId > 0 && isNewTurn && terminal && Date.now() - since > 800) {
          // Just unlock the composer. A failed turn is surfaced IN THE
          // CONVERSATION by HistoryView's OutcomeCard (red ⚠ 生成失败 + 重试),
          // exactly like web's OutcomeNoticeCard — not a dismissable banner.
          setBusy(false);
          return;
        }
        if (!sawNewInFlight && Date.now() - since > 15000) { setBusy(false); return; }
      } catch {}
      timer = setTimeout(tick, 1000);
    };
    tick();
    return () => { cancelled = true; if (timer != null) clearTimeout(timer); };
  }, [busy, agentId]);

  // Agent metadata — from /api/panes, fetched once on entry.
  const [agentMeta, setAgentMeta] = useState<{
    title?: string;
    agentType?: string;
    status?: string;
    machineLabel?: string;
    useCustomGateway: boolean | null;
  }>({
    // Seeded from the list row's route params — header title and the terminal
    // button paint on first frame instead of waiting for /api/panes.
    title: seedTitle ? String(seedTitle) : undefined,
    agentType: seedType ? String(seedType) : undefined,
    machineLabel: seedMachine ? String(seedMachine) : undefined,
    useCustomGateway: null,
  });

  // Model picker (cloud tenants): catalog + current choice from the pane
  // detail. models empty → no picker (self-hosted agents without the field).
  const [modelInfo, setModelInfo] = useState<{
    models: string[];
    current: string; // '' = platform default
    effective: string; // what '' resolves to
  } | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    api.getPane(agentId).then((p: any) => {
      if (!alive || !p) return;
      const opts = Array.isArray(p.runtime_ai_provider_options) ? p.runtime_ai_provider_options : [];
      const models: string[] = opts.flatMap((o: any) => (Array.isArray(o?.models) ? o.models : []));
      if (!models.length) return;
      setModelInfo({
        models,
        current: String(p.default_model || ''),
        effective: String(p.runtime_ai_default?.model || ''),
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [agentId]);

  const pickModel = async (model: string) => {
    if (modelSaving) return;
    setModelSaving(true);
    try {
      await api.updatePane(agentId, { default_model: model });
      setModelInfo((m) => (m ? { ...m, current: model } : m));
      setModelSheetOpen(false);
    } catch (e: any) {
      setVoiceError(t('chat.modelSaveFailed', { error: String(e?.message ?? e) }));
    } finally {
      setModelSaving(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [panes, poll] = await Promise.all([
          api.getPanes().catch(() => []),
          api.poll().catch(() => ({ agents: [] })),
        ]);
        if (!alive) return;
        const pane = panes.find((p) => p.pane_id?.split(':')[0] === agentId);
        const agent = poll.agents?.find(
          (a: any) => (a.name || a.pane_id?.split(':')[0]) === agentId,
        );
        const useCustomGateway = pane?.use_custom_gateway === true;
        // Merge over the seed — a fetch miss must not wipe what the list knew.
        setAgentMeta((m) => ({
          title: agent?.title || pane?.title || m.title,
          agentType: pane?.agent_type || agent?.agent_type || m.agentType,
          status: agent?.status ?? m.status,
          machineLabel: (pane as any)?.machine_label ?? m.machineLabel,
          useCustomGateway,
        }));
      } catch {
        if (alive) setAgentMeta((m) => ({ ...m, useCustomGateway: null }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [agentId]);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setVoiceError(null);
    try {
      if (busy) {
        // Queue — no optimistic bubble for queued items (they render in the
        // queue strip until flushed).
        const id = queueSeqRef.current;
        queueSeqRef.current += 1;
        setQueue((prev) => [...prev, { id, text: trimmed }]);
        return;
      }
      // Slash commands (/clear /compact) are intercepted server-side: no committed
      // turn, no reply-in-flight — locking busy on them waits out the 15s deadlock
      // fallback for nothing. (HistoryView likewise skips their optimistic bubble.)
      if (!/^\/\w+(\s|$)/.test(trimmed)) setBusy(true);
      setPending({ text: trimmed, nonce: Date.now() }); // optimistic: show q now
      await api.sendToAgent(agentId, trimmed, true);
    } catch (e: any) {
      setPending(null); // failed → drop the optimistic q
      setBusy(false);
      setVoiceError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
    } finally {
      setSending(false);
    }
  };

  // Dispatch an already-built message body: queue if a reply is in flight, else
  // lock busy + paint the optimistic bubble + POST. Shared by text send and the
  // attachment auto-send.
  const dispatchBody = async (body: string) => {
    if (busy) {
      const id = queueSeqRef.current;
      queueSeqRef.current += 1;
      setQueue((prev) => [...prev, { id, text: body }]);
      return;
    }
    // Slash commands don't lock busy (see submit()).
    if (!/^\/\w+(\s|$)/.test(body)) setBusy(true); // lock immediately — don't wait for the poll to notice
    setPending({ text: body, nonce: Date.now() });
    await api.sendToAgent(agentId, body, true);
  };

  // Attachments send THE MOMENT they're picked — no chip parked above the
  // composer waiting for a manual send. While uploading they show as a loading
  // card (spinner), then the message goes out and the card clears. Any text
  // already typed rides along as the caption.
  const sendAttachments = async (atts: PendingAttachment[]) => {
    if (!atts.length || sending) return;
    const caption = input.trim();
    setInput('');
    setAttachments(atts); // render as loading cards while they upload
    setSending(true);
    setVoiceError(null);
    try {
      const refs: string[] = [];
      let failed = 0;
      for (const a of atts) {
        try {
          const r = await uploadAttachment(agentId, a.uri, a.name, a.mime);
          const isVid = a.kind === 'video' || r.contentType.startsWith('video/');
          // Embed the ABSOLUTE host path (from file_ref) so the agent can Read it
          // (web parity; the renderer maps it back to a preview/download URL).
          const abs = r.fileRef
            ? '/' + r.fileRef.replace(/^file:\/\//, '').replace(/^\/+/, '')
            : r.url;
          refs.push(r.isImage ? `![${r.name}](${abs})` : `[${isVid ? '🎬 ' : ''}${r.name}](${abs})`);
        } catch {
          failed += 1;
        }
      }
      if (failed) setVoiceError(t('attach.uploadFailed', { count: failed }));
      if (!refs.length) return; // nothing uploaded → abort (finally clears the cards)
      const body = `${caption ? `${caption}\n\n` : ''}${refs.join('\n\n')}`;
      await dispatchBody(body);
    } catch (e: any) {
      setPending(null);
      setBusy(false);
      setVoiceError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
    } finally {
      setAttachments([]); // clear the loading cards
      setSending(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    if (sending) return;
    setInput('');
    setSending(true);
    setVoiceError(null);

    try {
      const body = text;
      // Slash commands don't lock busy (see submit()).
      if (!/^\/\w+(\s|$)/.test(body)) setBusy(true); // lock immediately — don't wait for the poll to notice
      setPending({ text: body, nonce: Date.now() });
      await api.sendToAgent(agentId, body, true);
    } catch (e: any) {
      setPending(null);
      setBusy(false);
      setInput((cur) => cur || text); // restore what the user typed
      setVoiceError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
    } finally {
      setSending(false);
    }
  };

  // Idle flush: when the reply completes and the queue is non-empty, merge the
  // queued messages into ONE send (order preserved). A failed flush restores the
  // batch, which re-fires this effect — WITHOUT the backoff that's an unthrottled
  // infinite retry loop while offline (error toast per network RTT, forever).
  const flushRetryRef = useRef(0);
  useEffect(() => {
    if (busy || sending || queue.length === 0) return;
    const attempt = flushRetryRef.current;
    const delay = attempt === 0 ? 0 : Math.min(15000, 1500 * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      const batch = queue;
      setQueue([]);
      const body = batch.map((b) => b.text).join('\n');
      setBusy(true);
      setPending({ text: body, nonce: Date.now() });
      api.sendToAgent(agentId, body, true).then(() => {
        flushRetryRef.current = 0;
      }).catch((e: any) => {
        flushRetryRef.current += 1;
        setPending(null);
        setBusy(false);
        setVoiceError(t('chat.sendFailed', { error: String(e?.message ?? e) }));
        // put the batch back so nothing is lost
        setQueue((prev) => [...batch, ...prev]);
      });
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, sending, queue.length]);

  // Stop the current generation: cicy (headless) → gateway cancel; terminal
  // agents (claude/codex) → Escape into the pane. Mirrors DispatcherChat.
  const stopGeneration = async () => {
    if (!busy) return;
    try {
      if (isHeadlessCicyAgent(agentMeta.agentType)) {
        await api.cancelCicyReply(agentId);
      } else {
        await api.sendKeys(agentId, 'Escape');
      }
      setBusy(false); // reflect at once; the entry check re-locks if still tearing down
    } catch (e: any) {
      setVoiceError(t('chat.stopFailed', { error: String(e?.message ?? e) }));
    }
  };

  // Each finalized live-recording turn → send to the agent. The first turn of a
  // session is prefixed so the agent knows to act as a quiet meeting recorder.
  const handleLiveTurn = (text: string) => {
    if (!meetingPrimedRef.current) {
      meetingPrimedRef.current = true;
      submit(`${t('meeting.assistantPrime')}\n\n${text}`);
    } else {
      submit(text);
    }
  };

  const startRecording = () => {
    meetingPrimedRef.current = false;
    Keyboard.dismiss();
    setRecording(true);
  };

  // cicy-type agents run headless (no ttyd pane) — no terminal to open. Every
  // other agent gets the terminal button in the header (full-screen webview on
  // the team server's gotty page). Hidden until the type is actually known —
  // defaulting to visible flashed the button on cicy agents while /api/panes
  // was still loading.
  const hasTerminal = !!agentMeta.agentType && !isHeadlessCicyAgent(agentMeta.agentType);
  const displayTitle = agentMeta.title || agentId;

  const openTerminal = () =>
    router.push({
      pathname: '/terminal/[agentId]',
      params: { agentId, title: displayTitle, agentType: agentMeta.agentType ?? '' },
    });

  return (
    <Screen>
      {/* ─── Header: back / avatar + title. Hidden inside Telegram, which
          provides its own back button + title bar. ─── */}
      {!inTg && (
      <View style={[styles.navRow, { borderBottomColor: theme.border }]}>
        <PressableScale onPress={() => router.back()} haptic scaleTo={0.94} style={styles.backBtn} hitSlop={6}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </PressableScale>
        <AgentAvatar agentType={agentMeta.agentType} title={displayTitle} size={36} />
        <View style={styles.headerInfo}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {displayTitle}
          </Text>
          {/* worker id + current model — id is the stable routing key; the
              model line only shows when the pane exposes a catalog (cloud). */}
          <View style={styles.headerSubRow}>
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {agentMeta.machineLabel ? `${agentId} · ${agentMeta.machineLabel}` : agentId}
            </Text>
          </View>
        </View>
        {modelInfo && (
          <PressableScale
            onPress={() => setModelSheetOpen(true)}
            haptic
            scaleTo={0.94}
            style={[styles.modelBtn, { borderColor: theme.border, backgroundColor: theme.surface }]}
            hitSlop={6}
          >
            <Ionicons name="hardware-chip-outline" size={13} color={theme.textMuted} />
            <Text variant="caption" numberOfLines={1} style={{ color: theme.textMuted, maxWidth: 92 }}>
              {modelLabel(modelInfo.current || modelInfo.effective)}
            </Text>
          </PressableScale>
        )}
        {hasTerminal && (
          <PressableScale onPress={openTerminal} haptic scaleTo={0.94} style={styles.termBtn} hitSlop={6}>
            <Ionicons name="terminal-outline" size={22} color={theme.text} />
          </PressableScale>
        )}
      </View>
      )}

      {/* Model picker — one CiCy Cloud provider, model dropdown only. */}
      <Modal visible={modelSheetOpen} transparent animationType="fade" onRequestClose={() => setModelSheetOpen(false)}>
        <Pressable style={styles.modelBackdrop} onPress={() => setModelSheetOpen(false)}>
          <View style={[styles.modelSheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
            <Text variant="caption" tone="faint" style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xs }}>
              {t('chat.modelPickerTitle')}
            </Text>
            {(['', ...(modelInfo?.models ?? [])]).map((m) => {
              const active = (modelInfo?.current ?? '') === m;
              const label = m ? modelLabel(m) : t('chat.modelDefault', { model: modelLabel(modelInfo?.effective || '') });
              return (
                <PressableScale
                  key={m || '__default'}
                  onPress={() => void pickModel(m)}
                  scaleTo={0.98}
                  disabled={modelSaving}
                  style={styles.modelRow}
                >
                  <Text variant="body" style={{ flex: 1, color: active ? theme.accent : theme.text }}>
                    {label}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={18} color={theme.accent} /> : null}
                </PressableScale>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <View style={{ flex: 1, backgroundColor: theme.bg }}>
          <HistoryView agentId={agentId} pending={pending} onReplyInFlight={() => setBusy(true)} agentType={agentMeta.agentType} busy={busy} />
          {/* Telegram hides our header (native back bar instead) — the terminal
              entry floats over the top-right corner of the history there. */}
          {inTg && hasTerminal && (
            <PressableScale
              onPress={openTerminal}
              haptic
              scaleTo={0.94}
              style={[styles.tgTermBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Ionicons name="terminal-outline" size={20} color={theme.text} />
            </PressableScale>
          )}
        </View>

        {voiceError ? (
          <View style={[styles.errorRow, { backgroundColor: theme.bg, borderTopColor: theme.border }]}>
            <Text variant="caption" tone="danger" numberOfLines={2}>
              {voiceError}
            </Text>
            <PressableScale onPress={() => setVoiceError(null)} hitSlop={8}>
              <Ionicons name="close" size={16} color={theme.textMuted} />
            </PressableScale>
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              backgroundColor: theme.bg,
              borderTopColor: theme.border,
              paddingBottom: keyboardShown
                ? (Platform.OS === 'ios' ? 45 : spacing.lg + 18)
                : spacing.lg,
            },
          ]}
        >
          {recording ? (
            <LiveRecordBar
              agentTitle={displayTitle}
              onTurn={handleLiveTurn}
              onClose={() => setRecording(false)}
              onError={(m) => setVoiceError(m)}
            />
          ) : (
          <>
          {/* Queued messages (busy period) — auto-flushed once the reply ends. */}
          {queue.length > 0 && (
            <View style={styles.queueBox}>
              <Text variant="caption" tone="faint">
                {t('chat.queuedHeader', { n: queue.length })}
              </Text>
              {queue.map((q) => (
                <View key={q.id} style={[styles.queueItem, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text variant="caption" tone="muted" numberOfLines={2} style={{ flex: 1 }}>
                    {q.text}
                  </Text>
                  <PressableScale onPress={() => setQueue((prev) => prev.filter((x) => x.id !== q.id))} hitSlop={6}>
                    <Ionicons name="close" size={14} color={theme.textFaint} />
                  </PressableScale>
                </View>
              ))}
            </View>
          )}
          {/* Attachments auto-send on pick; while uploading they show here as
              loading cards (spinner, dimmed thumb) — not removable chips waiting
              for a manual send. Cleared the moment the message goes out. */}
          {attachments.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.chipsRow}
            >
              {attachments.map((a) => (
                <View key={a.key} style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  {a.kind === 'image' || a.kind === 'video' ? (
                    <View style={styles.chipThumb}>
                      <Image source={{ uri: a.uri }} style={[StyleSheet.absoluteFill as any, { opacity: 0.5 }]} />
                      <View style={styles.chipSpinner}>
                        <ActivityIndicator size="small" color="#fff" />
                      </View>
                    </View>
                  ) : (
                    <View style={styles.chipThumb}>
                      <ActivityIndicator size="small" color={theme.textMuted} />
                    </View>
                  )}
                  <Text variant="caption" numberOfLines={1} style={styles.chipName}>
                    {a.name}
                  </Text>
                  <Text variant="caption" tone="faint">
                    {t('attach.uploading')}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}

          <View style={styles.composerRow}>
            {/* Unified one-pill composer (text ⇄ hold-to-talk, camera straight
                to photo/video capture, ⊕ = attach sheet). */}
            <Composer
              value={input}
              onChangeText={setInput}
              onSubmit={() => void send()}
              onTranscript={(txt) => void submit(txt)}
              onPickAttachments={(atts) => void sendAttachments(atts)}
              onError={(m) => setVoiceError(m)}
              disabled={false}
              sending={sending}
              busy={busy}
              onStop={() => { void stopGeneration(); }}
            />

            {/* Live recording — continuous on-device dictation that auto-sends
                each turn to the agent (the in-conversation meeting assistant).
                Opt-in via the drawer settings switch; hidden by default. */}
            {!IS_WEB && liveRecordEnabled && (
              <PressableScale
                onPress={startRecording}
                haptic
                scaleTo={0.94}
                disabled={sending}
                style={[styles.modeToggle, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <MaterialCommunityIcons name="account-voice" size={22} color={theme.text} />
              </PressableScale>
            )}
          </View>
          </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  queueBox: { gap: 6, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  queueItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
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
  headerInfo: {
    flex: 1,
    gap: 2,
  },
  headerSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  termBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  tgTermBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.md,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chipsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    paddingLeft: 6,
    paddingRight: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipThumb: {
    width: 28,
    height: 28,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSpinner: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  videoBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipName: {
    flexShrink: 1,
  },
  modeToggle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  modelBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  modelSheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing['2xl'],
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
});
