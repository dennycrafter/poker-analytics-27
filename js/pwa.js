// PWA wiring (STEP C): registers the service worker that makes the app
// installable and lets the shell load offline. Data sync stays online-only
// until STEP D; the worker never touches Supabase traffic (see sw.js).

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service workers need a secure context; http://localhost counts as one.
  if (!window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      // Not fatal: the app works without it, it just is not installable.
      console.error('pwa: service worker registration failed', err);
    });
  }, { once: true });
}
