// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// This app is primarily a conversation with the Hub (the fleet coordinator).
// So the Hub is the home/root when one is connected; teams are a separate,
// secondary stack you step into from there.
//
//   hub connected        → /hub   (the coordinator conversation — the home)
//   no hub, has teams     → /agents (teams stack; connect a Hub from its drawer)
//   fresh (nothing yet)   → /login  (cloud-first; QR scan is the secondary path)
export default function Index() {
  const hub = useAuthStore((s) => s.hub);
  const teams = useAuthStore((s) => s.teams);
  if (hub) return <Redirect href="/hub" />;
  if (teams.length === 0) return <Redirect href="/login" />;
  return <Redirect href="/agents" />;
}
