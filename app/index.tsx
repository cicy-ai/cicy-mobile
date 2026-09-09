// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// Onboarding order:
//   1. must sign in to the CiCy Hub first (email + code);
//   2. signed in → the machine list (every cicy-code of that account);
//   a device with only QR-scanned teams and no hub account goes straight to
//   the team agents list.
export default function Index() {
  const session = useAuthStore((s) => s.session);
  const teams = useAuthStore((s) => s.teams);
  if (!session && teams.length === 0) return <Redirect href="/login" />;
  if (!session) return <Redirect href="/agents" />;
  return <Redirect href="/machines" />;
}
