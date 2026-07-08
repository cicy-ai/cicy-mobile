// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Wire types for cicy-code chat-ws + REST. Keep small — only what mobile needs.

export type Agent = {
  // DB row id (numeric in current backend). Don't use for routing — it isn't
  // the chat-ws subscription key.
  id?: number | string;
  // Host pane (often shared across agents — e.g. "w-10001").
  pane_id?: string;
  // The chat-ws routing key (e.g. "w-10018"). This is what subscribe + push
  // both expect. Required in practice even though the server marks it optional.
  name?: string;
  title?: string;
  status?: string;
  agent_type?: string;
  machine_id?: string;
  // Working directory of the worker pane (joined client-side from /api/panes).
  // Not present in /api/poll output — we look it up by pane name.
  workspace?: string;
};

export type PollData = {
  agents: Agent[];
  statuses?: Record<string, string>;
  system_resources?: unknown;
};

// Server → client WS envelope. We only narrow the types we react to.
// Streaming delta payload (cicy AI gateway). Backend shape, verified against
// api/mgr/ai_gateway_audit.go: { delta, agent_id, turn_id, history_id,
// conversation_id }. ai_chunk = answer text; thinking_chunk = reasoning text.
export type StreamDelta = {
  agent_id?: string;
  delta?: string;
  turn_id?: string;
  history_id?: number;
  conversation_id?: string;
};

export type WsServerMessage =
  | { type: 'poll_data'; data: PollData }
  | { type: 'status_change'; data: { agent_id?: string; status: string; turn_id?: string } }
  | { type: 'ai_chunk'; data: StreamDelta }
  | { type: 'thinking_chunk'; data: StreamDelta }
  | { type: 'current_updated'; data: { agent_id?: string } }
  | { type: 'user_q'; data: { agent_id?: string; text: string } }
  | { type: 'ping'; data?: unknown }
  | { type: string; data?: unknown }; // fallback for unhandled types

export type WsClientMessage =
  | { type: 'pong'; data?: { ts?: number } }
  | { type: 'register_active_channel'; data: { agent_id: string; client_id: string } }
  | { type: 'poll_request'; data?: unknown }
  | { type: string; data?: unknown };

export type SendToAgentBody = {
  win_id: string;
  text: string;
  submit?: boolean;
};

// Conversation turn shape returned by GET /api/agents/history-view/{paneId}.
// Mirrors what the desktop ChatHistoryView consumes — see
// api/mgr/agent_inspector.go:2738 for the producer.
// Single source of truth = the web-mirror types (src/lib/history/types.ts),
// copied verbatim from cicy-code. Re-exported here so existing importers keep
// working without churn.
export type { HistoryTurn } from '@/src/lib/history/types';
import type { HistoryTurn } from '@/src/lib/history/types';
export type HistoryStep = NonNullable<import('@/src/lib/history/types').HistoryTurn['steps']>[number];

export type HistoryView = {
  pane_id: string;
  data: HistoryTurn[];
};

// ── Two-part history endpoints (committed current-history + current-reply tail) ──
// Mirrors the desktop CurrentHistoryView model. Producers in
// api/mgr/agent_inspector.go: history-ids / current-history / current-reply.

// One raw message straight out of current.json's request body. `content` is
// provider-shaped (Anthropic content[] blocks / OpenAI strings / function_call …)
// and must be parsed client-side into HistoryTurn[] (buildTurnsFromRawItems).
export type RawHistoryItem = {
  id: number;
  history_id: number;
  role: string;
  content: unknown;
  conversation_id?: string;
};

export type HistoryIdsResp = {
  conversation_id: string;
  id: number; // == maxID — id of the last committed item (q_last)
  model?: string;
  provider?: string;
};

export type CurrentHistoryResp = {
  pane_id: string;
  conversation_id: string;
  items: RawHistoryItem[];
  has_more: boolean;
  next_before?: number;
};

export type CurrentReplyResp = {
  pane_id: string;
  conversation_id: string;
  reply_conversation_id?: string;
  history_id: number; // == committedMaxId + 1 — the slot the answer occupies
  turn_id?: string;
  status?: string;
  complete: boolean;
  question?: string; // validation only; the q is rendered from committed
  answer?: string;
  thinking?: string;
  // The whole in-flight turn as ORDERED items (serial SSE order: thinking →
  // tool_use → … → text). Rendering these in order keeps a multi-round turn
  // correct instead of flattening to thinking+answer. Mirrors desktop
  // CurrentHistoryView's live-tail build. Absent on older backends → fall back
  // to answer/thinking.
  items?: { type?: string; thinking?: string; text?: string; name?: string; input?: unknown; tool_id?: string }[];
  updated_at?: string;
  model?: string;
};

// /api/panes — superset of /api/poll with config fields. We only care about a
// handful of properties; the rest can stay as `any` to avoid keeping a model
// in sync with the backend schema.
export type Pane = {
  pane_id: string; // e.g. "w-10022:main.0"
  agent_type?: string;
  title?: string;
  active?: number;
  use_custom_gateway?: boolean;
  default_model?: string;
  // "master" | "worker" | "" — masters are hosts (e.g. w-10001), workers are
  // children panes that route through them. Mobile filters by this.
  role?: string;
  // Absolute path the agent runs in, e.g. "/home/cicy/cicy-ai/workers/w-10036".
  workspace?: string;
};

export type PanesResponse = {
  panes?: Pane[];
};
