import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// The app is a pure client with no backend of its own — everything it talks to
// is a team server (cicy-cloud via email login, or a self-hosted one via QR).
// No team yet → cloud-first login screen (QR scan is its secondary path);
// otherwise → agents.
export default function Index() {
  const teams = useAuthStore((s) => s.teams);
  if (teams.length === 0) return <Redirect href="/login" />;
  return <Redirect href="/agents" />;
}
