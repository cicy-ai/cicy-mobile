// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Verbatim subset of cicy-code app/src/components/chat/history/types.ts —
// kept in a mirror path so future diffs against the web reference are 1:1.
// (User rule: the web chat already stepped on every pitfall; COPY it, don't
// re-invent. See memory mobile-chat-mirror-web-chat.)
export type HistoryTurn = {
  history_id?: number;
  conversation_id?: string;
  role?: string;
  text?: string;
  q: string;
  a?: string;
  steps?: Array<{ type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'tool'; tools: any[] }>;
  status?: string;
  ts?: number;
  start_ts?: number;
  credit?: number;
  model?: string;
  raw_items?: RawHistoryItem[];
  // Set on a cicy "turn produced no reply" system notice: "cancelled" | "error".
  outcome?: string;
  outcomeDetail?: string;
  // Client-only optimistic-send placeholder (never comes from the backend).
  _optimistic?: boolean;
  // Mobile-only compat: some legacy callers key rows by turn_id.
  turn_id?: string;
};

export type RawHistoryItem = Record<string, any>;

export type EnvironmentContextData = {
  cwd?: string;
  shell?: string;
  current_date?: string;
  timezone?: string;
};
