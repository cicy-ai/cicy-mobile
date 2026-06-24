import { Platform } from 'react-native';

// The static boot splash (app/+html.tsx) covers the whole startup: JS download
// → React mount → first data. Screens call dismissBootSplash() when they have
// real content to show, so the user sees ONE continuous loading state instead
// of splash-spinner → screen-spinner relay. _layout keeps a safety timeout so
// it can never stick forever.
let dismissed = false;

export function dismissBootSplash() {
  if (dismissed || Platform.OS !== 'web' || typeof document === 'undefined') return;
  dismissed = true;
  // Healthy boot — re-arm the one-shot chunk-heal reload guard (+html.tsx).
  try {
    sessionStorage.removeItem('cicy-chunk-heal');
  } catch {}
  const el = document.getElementById('boot-splash');
  if (!el) return;
  el.style.transition = 'opacity 160ms ease-out';
  el.style.opacity = '0';
  setTimeout(() => el.remove(), 200);
}
