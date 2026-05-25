import { Redirect } from 'expo-router';

import { useAuthStore } from '@/src/store/auth';

export default function Index() {
  const teams = useAuthStore((s) => s.teams);
  // First-run UX: nothing to log in to → straight into the scan flow. The
  // /scan screen handles its own empty state with explicit instructions on
  // how to surface the QR code in the cicy-code web UI.
  if (teams.length === 0) return <Redirect href="/scan" />;
  return <Redirect href="/agents" />;
}
