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
export type WsServerMessage =
  | { type: 'poll_data'; data: PollData }
  | { type: 'status_change'; data: { agent_id?: string; status: string } }
  | { type: 'ai_chunk'; data: { agent_id?: string; text?: string; chunk?: string; done?: boolean } }
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
export type HistoryStep =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  // `arg`/`result` are the desktop parser's field names (CurrentHistoryView);
  // `input`/`output` are the legacy history-view shape. The mobile ToolStrip
  // only reads `name`, so both coexist harmlessly.
  | { type: 'tool'; tools: { name?: string; arg?: string; result?: string; input?: string; output?: string; index?: number }[] }
  | { type: string; text?: string; tools?: unknown };

export type HistoryTurn = {
  q: string;
  a: string;
  steps?: HistoryStep[];
  status?: 'pending' | 'streaming' | 'tool_use' | 'text' | 'done' | string;
  ts?: number;
  start_ts?: number;
  credit?: number;
  model?: string;
  history_id?: number;
  conversation_id?: string;
  turn_id?: string;
  // Carried by the two-part parser (historyParse). `role` distinguishes
  // system-notice / user / assistant turns; `text` is the user-question or
  // system-notice body. The mobile renderer ignores them (reads q/a/steps).
  role?: string;
  text?: string;
};

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
