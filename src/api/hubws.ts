// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Hub WebSocket client — the single channel a scanned Hub connection rides.
// Protocol: cicy-hub/docs/mobile-integration.md (frozen by w-10122).
//   connect  wss://<hubUrl>/_client?token=<hubToken>   (101 = connected)
//   server→  directory (full snapshot, first frame) · agent_upsert · team_offline
//            · chat {agent, frame:<node chat-ws frame>} · history {req_id,…} · ack · error
//   client→  subscribe {agent} · unsubscribe {agent} · history_req {req_id,agent,limit?}
//            · send {agent, text, submit?}
// agent addressing: "<team>.<wid>" (e.g. "teamA.w-1001:main.0").

export type HubWsStatus = 'idle' | 'connecting' | 'open' | 'closed';

// One directory row (a reachable agent under some team in this hub).
export type HubAgent = {
  wid: string;
  title: string;
  agent_type: string;
  role?: string;
  status?: string;
  model?: string;
  context_used_pct?: number;
  context_window?: number;
  reach_url: string; // https://<team>.hub.cicy-ai.com — the node's transparent base
  token: string; // that node's api_token (hub is the internal broker)
  // Derived client-side: the "<team>.<wid>" address used for subscribe/send.
  team: string;
  addr: string;
};

export type HubDirectory = HubAgent[];

// A chat frame relayed from a subscribed agent's node chat-ws (unwrapped one
// envelope layer) — same shape ChatWsClient already consumes.
export type HubChatFrame = { type: string; data?: any };

type DirListener = (dir: HubDirectory) => void;
type ChatListener = (agentAddr: string, frame: HubChatFrame) => void;
type StatusListener = (s: HubWsStatus) => void;

type Config = { hubUrl: string; hubToken: string };

function normTeamAgent(team: string, agent: HubAgent): HubAgent {
  const shortWid = agent.wid.split(':')[0];
  return { ...agent, team, addr: `${team}.${shortWid}` };
}

export class HubWsClient {
  private ws: WebSocket | null = null;
  private status: HubWsStatus = 'idle';
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reqSeq = 0;
  // Latest full directory, kept so a late subscriber gets the current snapshot.
  private dir = new Map<string, HubAgent>(); // key = addr
  private dirListeners = new Set<DirListener>();
  private chatListeners = new Set<ChatListener>();
  private statusListeners = new Set<StatusListener>();
  private historyResolvers = new Map<string, (turns: any[]) => void>();
  // Agents we want subscribed — re-sent on every (re)connect.
  private subscribed = new Set<string>();

  constructor(private readonly cfg: Config) {}

  private setStatus(s: HubWsStatus) {
    if (this.status === s) return;
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }

  private buildUrl(): string {
    const base = this.cfg.hubUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    return `${base}/_client?token=${encodeURIComponent(this.cfg.hubToken)}`;
  }

  private emitDir() {
    const list = Array.from(this.dir.values());
    this.dirListeners.forEach((cb) => cb(list));
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
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* next close surfaces it */ }
      }
    }, 25000);
  }
  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  connect() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.buildUrl());
    } catch {
      this.setStatus('closed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setStatus('open');
      // Re-assert every wanted subscription after a reconnect.
      Array.from(this.subscribed).forEach((addr) => this.rawSend({ type: 'subscribe', agent: addr }));
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'directory': {
          this.dir.clear();
          const teams = Array.isArray(msg.teams) ? msg.teams : [];
          for (const t of teams) {
            const team = String(t?.team || '');
            for (const a of Array.isArray(t?.agents) ? t.agents : []) {
              const row = normTeamAgent(team, a as HubAgent);
              this.dir.set(row.addr, row);
            }
          }
          this.emitDir();
          break;
        }
        case 'agent_upsert': {
          const team = String(msg?.team || '');
          if (msg?.agent) {
            const row = normTeamAgent(team, msg.agent as HubAgent);
            this.dir.set(row.addr, row);
            this.emitDir();
          }
          break;
        }
        case 'team_offline': {
          const team = String(msg?.team || '');
          let changed = false;
          Array.from(this.dir.entries()).forEach(([addr, a]) => {
            if (a.team === team) { this.dir.delete(addr); changed = true; }
          });
          if (changed) this.emitDir();
          break;
        }
        case 'chat': {
          const agent = String(msg?.agent || '');
          const frame = (msg?.frame ?? {}) as HubChatFrame;
          if (agent && frame && typeof frame.type === 'string') {
            this.chatListeners.forEach((cb) => cb(agent, frame));
          }
          break;
        }
        case 'history': {
          const rid = String(msg?.req_id || '');
          const resolve = this.historyResolvers.get(rid);
          if (resolve) { this.historyResolvers.delete(rid); resolve(Array.isArray(msg?.turns) ? msg.turns : []); }
          break;
        }
        case 'ping':
          this.rawSend({ type: 'pong' });
          break;
        // ack / error: nothing global to do (history uses req_id above).
      }
    };

    ws.onerror = () => { /* onclose handles reconnect */ };
    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      this.setStatus('closed');
      this.scheduleReconnect();
    };
  }

  private rawSend(obj: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch { /* surfaces via onclose */ }
    }
  }

  // ── public API ──
  subscribe(agentAddr: string) {
    this.subscribed.add(agentAddr);
    this.rawSend({ type: 'subscribe', agent: agentAddr });
  }
  unsubscribe(agentAddr: string) {
    this.subscribed.delete(agentAddr);
    this.rawSend({ type: 'unsubscribe', agent: agentAddr });
  }
  send(agentAddr: string, text: string, submit = true) {
    this.rawSend({ type: 'send', agent: agentAddr, text, submit });
  }
  // Ask the hub to fetch this agent's committed history (it proxies current-history).
  historyReq(agentAddr: string, limit?: number): Promise<any[]> {
    const rid = `h-${Date.now().toString(36)}-${++this.reqSeq}`;
    return new Promise((resolve) => {
      this.historyResolvers.set(rid, resolve);
      this.rawSend({ type: 'history_req', req_id: rid, agent: agentAddr, ...(limit ? { limit } : {}) });
      setTimeout(() => {
        if (this.historyResolvers.has(rid)) { this.historyResolvers.delete(rid); resolve([]); }
      }, 15000);
    });
  }

  getDirectory(): HubDirectory { return Array.from(this.dir.values()); }
  getAgent(addr: string): HubAgent | undefined { return this.dir.get(addr); }

  onDirectory(cb: DirListener): () => void {
    this.dirListeners.add(cb);
    if (this.dir.size) cb(Array.from(this.dir.values()));
    return () => this.dirListeners.delete(cb);
  }
  onChat(cb: ChatListener): () => void {
    this.chatListeners.add(cb);
    return () => this.chatListeners.delete(cb);
  }
  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.setStatus('closed');
  }
}
