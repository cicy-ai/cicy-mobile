// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Root-mounted, renders nothing. Owns one WebSocket per connected Hub, keeps
// each hub's latest directory, and feeds the UNION into the team list (via
// auth.setHubTeams). Living at the layout root — not on any screen — is what
// lets teams stay populated no matter which screen is showing (the app opens
// straight into /agents now, with no Hub screen to hold the socket).
import { useEffect, useRef } from 'react';

import { HubWsClient, type HubAgent } from '@/src/api/hubws';
import { useAuthStore, type HubDirEntry } from '@/src/store/auth';

type Entry = { client: HubWsClient; dir: HubAgent[]; token: string };

export function HubConnector() {
  const hubs = useAuthStore((s) => s.hubs);
  const setHubTeams = useAuthStore((s) => s.setHubTeams);

  const clientsRef = useRef<Map<string, Entry>>(new Map());

  useEffect(() => {
    const map = clientsRef.current;

    const recompute = () => {
      const entries: HubDirEntry[] = [];
      map.forEach((e, hubId) => entries.push({ hubId, hubToken: e.token, agents: e.dir }));
      void setHubTeams(entries);
    };

    const wanted = new Set(hubs.map((h) => h.id));
    // Drop hubs that were disconnected.
    Array.from(map.keys()).forEach((hubId) => {
      if (!wanted.has(hubId)) {
        map.get(hubId)?.client.close();
        map.delete(hubId);
      }
    });
    // Connect new hubs; reconnect ones whose token changed (re-scan).
    for (const h of hubs) {
      const existing = map.get(h.id);
      if (existing && existing.token === h.token) continue;
      if (existing) existing.client.close();
      const client = new HubWsClient({ hubUrl: h.url, hubToken: h.token });
      const entry: Entry = { client, dir: [], token: h.token };
      map.set(h.id, entry);
      client.onDirectory((d) => {
        entry.dir = d;
        recompute();
      });
      client.connect();
    }
    recompute();
  }, [hubs, setHubTeams]);

  // Tear every socket down when the app itself unmounts.
  useEffect(
    () => () => {
      clientsRef.current.forEach((e) => e.client.close());
      clientsRef.current.clear();
    },
    [],
  );

  return null;
}
