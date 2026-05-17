import { useAuthStore } from '@/src/store/auth';
import type { HistoryView, Pane, PanesResponse, PollData } from './types';

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
      'X-Cicy-Token': token,
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
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
};
