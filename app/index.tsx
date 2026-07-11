// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// Onboarding order:
//   1. must sign in first (cloud session);
//   2. once signed in, if there's no hub yet → scan one (teams come from hubs);
//   3. otherwise → the team agents list (opens on the first team).
export default function Index() {
  const session = useAuthStore((s) => s.session);
  const hubs = useAuthStore((s) => s.hubs);
  if (!session) return <Redirect href="/login" />;
  if (hubs.length === 0) return <Redirect href="/scan" />;
  return <Redirect href="/agents" />;
}
