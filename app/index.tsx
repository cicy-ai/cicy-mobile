// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// Teams are sourced from the connected Hub(s), so the HOME is the team agents
// list (/agents), which opens on the first team. Routing:
//   • no hub AND no teams AND not signed in → cloud-first login (onboarding)
//   • no hub AND no teams but signed in     → scan a hub QR to get teams
//   • otherwise                             → the team agents list
export default function Index() {
  const hubs = useAuthStore((s) => s.hubs);
  const teams = useAuthStore((s) => s.teams);
  const session = useAuthStore((s) => s.session);
  if (hubs.length === 0 && teams.length === 0) {
    return <Redirect href={session ? '/scan' : '/login'} />;
  }
  return <Redirect href="/agents" />;
}
