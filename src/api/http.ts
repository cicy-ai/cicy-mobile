// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Platform } from 'react-native';

import { useAuthStore } from '@/src/store/auth';
import type {
  CurrentHistoryResp,
  CurrentReplyResp,
  HistoryIdsResp,
  HistoryView,
  Pane,
  PanesResponse,
  PollData,
} from './types';

function requireAuth() {
  const { serverUrl, token } = useAuthStore.getState();
  if (!serverUrl || !token) throw new Error('not authenticated');
  return { serverUrl, token };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { serverUrl, token } = requireAuth();
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // X-Cicy-Token is a non-safelisted custom header. On web it forces a CORS
      // preflight, and cicy-code's allow-list doesn't include it, so the browser
      // blocks the request ("Failed to fetch"). The server authenticates via
      // Authorization: Bearer anyway (X-Cicy-Token on its own returns 401), so we
      // only send it on native, where there's no CORS to satisfy.
      ...(Platform.OS === 'web' ? {} : { 'X-Cicy-Token': token }),
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let text = await res.text().catch(() => '');
    // Gateway error pages (Cloudflare 5xx etc.) are full HTML documents —
    // never surface raw markup in the UI. Keep short plain-text bodies only.
    if (/<!doctype|<html|<head|<body/i.test(text)) text = '';
    else text = text.trim().slice(0, 200);
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  poll: (paneId?: string) =>
    request<PollData>(`/api/poll${paneId ? `?pane_id=${encodeURIComponent(paneId)}` : ''}`),

  // Send a chat prompt to an agent's tmux pane. This is the same endpoint the
  // web UI's `apiService.sendCommand` calls — text lands in the pane's stdin
  // with Enter, exactly as if the user had typed it.
  sendToAgent: (winId: string, text: string, submit = true) =>
    request<unknown>('/api/tmux/send', {
      method: 'POST',
      body: JSON.stringify({ win_id: winId, text, submit }),
    }),

  // Raw key into the pane (Escape interrupts a running terminal agent).
  sendKeys: (winId: string, keys: string) =>
    request<unknown>('/api/tmux/send-keys', {
      method: 'POST',
      body: JSON.stringify({ win_id: winId, keys }),
    }),

  // Cancel the in-flight gateway reply of a cicy (headless) agent.
  cancelCicyReply: (paneId: string) =>
    request<unknown>('/api/cicy/cancel', {
      method: 'POST',
      body: JSON.stringify({ pane_id: paneId }),
    }),

  // Single pane detail — carries the model-picker fields for cloud tenants:
  // runtime_ai_provider_options (single CiCy Cloud provider + model catalog),
  // default_model ('' = platform default), runtime_ai_default (effective).
  getPane: (id: string) =>
    request<Record<string, any>>(`/api/tmux/panes/${encodeURIComponent(id)}`),
  // Model choice: PATCH {default_model} — must be in the catalog ('' resets
  // to platform default). Provider switching is intentionally NOT exposed
  // (tenants see only CiCy Cloud; the server strips/rejects provider writes).
  updatePane: (id: string, data: Record<string, unknown>) =>
    request<unknown>(`/api/tmux/panes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // ── Team-member management (same endpoints as cicy-code web) ──
  restartPane: (id: string) =>
    request<unknown>(`/api/tmux/panes/${encodeURIComponent(id)}/restart`, { method: 'POST' }),
  deletePane: (id: string) =>
    request<unknown>(`/api/tmux/panes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Create a worker bound to the team master (TeamPanel's createAndBind
  // payload). Cloud default teams accept agent_type 'cicy' ONLY (server
  // enforces; per w-10122 the endpoint itself is identical).
  createPane: (data: Record<string, unknown>) =>
    request<{ pane_id?: string; session?: string; success?: boolean; error?: string }>(
      '/api/tmux/create',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  // Conversation turns (q + a + steps) for an agent. Same endpoint the desktop
  // ChatHistoryView consumes; pane id format is the short pane name (e.g. w-10018).
  getHistoryView: (paneId: string, opts?: { limit?: number; offset?: number; q?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.q) params.set('q', opts.q);
    const qs = params.toString();
    return request<HistoryView>(
      `/api/agents/history-view/${encodeURIComponent(paneId)}${qs ? `?${qs}` : ''}`,
    );
  },

  // Full pane configs — only needed to learn `use_custom_gateway` per agent so
  // we can hide the History tab for non-gateway (claude-code direct) agents.
  getPanes: async (): Promise<Pane[]> => {
    const res = await request<PanesResponse | Pane[]>('/api/panes');
    return Array.isArray(res) ? res : (res?.panes ?? []);
  },

  // ── Two-part history (committed window + reply tail), mirrors desktop ──
  // history-ids: latest conversation id + maxID (id of q_last) + model/provider.
  getHistoryIds: (paneId: string, conversationId?: string) =>
    request<HistoryIdsResp>(
      `/api/agents/history-ids/${encodeURIComponent(paneId)}` +
        (conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : ''),
    ),

  // current-history: windowed committed items (raw current.json messages).
  // `before` pages older (loadEarlier); omit it for the latest window.
  getCurrentHistory: (
    paneId: string,
    opts?: { limit?: number; before?: number; conversationId?: string },
  ) => {
    const p = new URLSearchParams();
    if (opts?.limit != null) p.set('limit', String(opts.limit));
    if (opts?.before != null) p.set('before', String(opts.before));
    if (opts?.conversationId) p.set('conversation_id', opts.conversationId);
    const qs = p.toString();
    return request<CurrentHistoryResp>(
      `/api/agents/current-history/${encodeURIComponent(paneId)}${qs ? `?${qs}` : ''}`,
    );
  },

  // current-reply: the in-flight answer for q_last (history_id == maxID + 1).
  getCurrentReply: (paneId: string, conversationId?: string) =>
    request<CurrentReplyResp>(
      `/api/agents/current-reply/${encodeURIComponent(paneId)}` +
        (conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : ''),
    ),
};
