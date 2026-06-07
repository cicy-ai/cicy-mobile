import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

// The app is a pure client with no backend of its own — everything it talks to
// is the team server whose address came in via QR scan / paste. So routing is
// trivial: no team yet → scan flow; otherwise → agents.
export default function Index() {
  const teams = useAuthStore((s) => s.teams);
  if (teams.length === 0) return <Redirect href="/scan" />;
  return <Redirect href="/agents" />;
}
