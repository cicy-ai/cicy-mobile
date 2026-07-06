// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import type { WsClientMessage, WsServerMessage } from './types';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'closed';

type Listener = (msg: WsServerMessage) => void;
type StatusListener = (s: WsStatus) => void;

type Config = {
  serverUrl: string;
  token: string;
  clientId: string;
  agentId: string;
};

export class ChatWsClient {
  private ws: WebSocket | null = null;
  private status: WsStatus = 'idle';
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly cfg: Config) {}

  private setStatus(s: WsStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  private buildUrl(): string {
    // serverUrl is http(s)://host[:port]; swap to ws(s) for the WS handshake.
    const base = this.cfg.serverUrl.replace(/^http/, 'ws');
    const params = new URLSearchParams({
      master_agent_id: this.cfg.agentId,
      token: this.cfg.token,
      client_id: this.cfg.clientId,
      platform: 'mobile',
    });
    return `${base}/api/chat/ws?${params.toString()}`;
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delaySec = Math.min(30, 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delaySec * 1000);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping', data: { ts: Date.now() } }));
        } catch {
          /* ignore — next message attempt or close will surface it */
        }
      }
    }, 25000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  connect() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.buildUrl());
    } catch (e) {
      this.setStatus('closed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus('open');
      // Tell the server which agent we're tracking.
      this.send({
        type: 'register_active_channel',
        data: { agent_id: this.cfg.agentId, client_id: this.cfg.clientId },
      });
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg: WsServerMessage | null = null;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as WsServerMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      // Server pings → reply pong.
      if (msg.type === 'ping') {
        this.send({ type: 'pong', data: { ts: Date.now() } });
        return;
      }
      this.listeners.forEach((cb) => cb(msg!));
    };

    ws.onerror = () => {
      // onclose will follow with reconnect logic.
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  send(msg: WsClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch {
        /* swallow — surfaces via onclose */
      }
    }
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus('closed');
  }
}
