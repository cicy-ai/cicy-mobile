import { Platform } from 'react-native';

// cicy-code chat WebSocket: subscribe to one agent's live AI stream and receive
// answer / thinking deltas pushed in real time (replaces the current-reply poll).
//
// Contract (agreed with cicy-code/w-10064):
//   connect  GET /api/chat/ws?master_agent_id=<agentId>&token=<api_token>
//                              &client_id=<install id>&platform=<os>
//   subscribe send {type:'register_active_channel', data:{agent_id}}
//   events   ai_chunk / thinking_chunk (delta — append VERBATIM, whitespace is
//            significant), status_change (thinking|tool_use), current_updated
//            (turn finalized; carries a full snapshot). Everything else
//            (system_resources …) is ignored.
//
// master_agent_id is only a channel/slot label — routing is purely by the
// register_active_channel agent_id. client_id must be install-unique (a repeat
// supersedes the old slot after a brief 4409).

export type StreamEvent =
  | { kind: 'ai_chunk'; agentId: string; conversationId: string; turnId: string; historyId: number; delta: string }
  | { kind: 'thinking_chunk'; agentId: string; conversationId: string; turnId: string; historyId: number; delta: string }
  | { kind: 'status_change'; agentId: string; conversationId: string; turnId: string; historyId: number; status: string; toolName?: string }
  | {
      kind: 'current_updated';
      agentId: string;
      conversationId: string;
      turnId: string;
      historyId: number;
      status: string;
      answer: string;
      thinking: string;
      question?: string;
    };

type Opts = {
  serverUrl: string;
  token: string;
  agentId: string;
  clientId: string;
  onEvent: (e: StreamEvent) => void;
  onConnected: (connected: boolean) => void;
};

const str = (v: unknown) => String(v ?? '');
const num = (v: unknown) => Number(v ?? 0) || 0;

// http→ws, https→wss ("https".replace(/^http/) === "wss").
const toWsBase = (serverUrl: string) => serverUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');

// Opens the stream and keeps it alive (auto-reconnect with backoff). Returns a
// close() that tears everything down — call it on unmount / blur.
export function openChatStream(opts: Opts): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    const q =
      `master_agent_id=${encodeURIComponent(opts.agentId)}` +
      `&token=${encodeURIComponent(opts.token)}` +
      `&client_id=${encodeURIComponent(opts.clientId)}` +
      `&platform=${encodeURIComponent(Platform.OS)}`;
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${toWsBase(opts.serverUrl)}/api/chat/ws?${q}`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      try {
        sock.send(JSON.stringify({ type: 'register_active_channel', data: { agent_id: opts.agentId } }));
      } catch {
        /* will reconnect on close */
      }
      opts.onConnected(true);
    };

    sock.onmessage = (ev: WebSocketMessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      const type = str(msg?.type);
      const d = msg?.data ?? {};
      const base = {
        agentId: str(d.agent_id),
        conversationId: str(d.conversation_id),
        turnId: str(d.turn_id),
        historyId: num(d.history_id),
      };
      if (type === 'ai_chunk') opts.onEvent({ kind: 'ai_chunk', ...base, delta: str(d.delta) });
      else if (type === 'thinking_chunk') opts.onEvent({ kind: 'thinking_chunk', ...base, delta: str(d.delta) });
      else if (type === 'status_change')
        opts.onEvent({ kind: 'status_change', ...base, status: str(d.status), toolName: d.tool_name ? str(d.tool_name) : undefined });
      else if (type === 'current_updated')
        opts.onEvent({
          kind: 'current_updated',
          ...base,
          status: str(d.status),
          answer: str(d.answer),
          thinking: str(d.thinking),
          question: d.question != null ? str(d.question) : undefined,
        });
      // ignore system_resources and any other types
    };

    sock.onerror = () => {
      /* the close handler does the reconnect */
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      opts.onConnected(false);
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    retry += 1;
    const delay = Math.min(1000 * 2 ** Math.min(retry, 4), 15000); // 2s,4s,8s,16s→15s cap
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      ws = null;
    }
  };
}
