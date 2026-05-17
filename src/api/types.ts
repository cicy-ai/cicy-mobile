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
  | { type: 'tool'; tools: { name?: string; input?: string; output?: string; index?: number }[] }
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
};

export type HistoryView = {
  pane_id: string;
  data: HistoryTurn[];
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
};

export type PanesResponse = {
  panes?: Pane[];
};
