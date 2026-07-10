// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// This app is primarily a conversation with the Hub (the fleet coordinator),
// so the HOME is always the Hub screen — even before one is connected, where it
// shows a scan-to-connect prompt. Teams are a separate, secondary stack reached
// from the Hub's ☰ org/teams drawer. The one exception is a brand-new install
// with nothing at all: send it to the cloud-first login so onboarding still works.
export default function Index() {
  const hub = useAuthStore((s) => s.hub);
  const teams = useAuthStore((s) => s.teams);
  const session = useAuthStore((s) => s.session);
  if (!hub && teams.length === 0 && !session) return <Redirect href="/login" />;
  return <Redirect href="/hub" />;
}
