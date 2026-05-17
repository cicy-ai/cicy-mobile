import { Redirect } from 'expo-router';
import { useAuthStore } from '@/src/store/auth';

export default function Index() {
  const token = useAuthStore((s) => s.token);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  if (!token || !serverUrl) return <Redirect href="/settings" />;
  return <Redirect href="/agents" />;
}
