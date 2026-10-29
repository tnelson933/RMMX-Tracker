/**
 * Picks up a new release without getting in the way.
 *
 * When a new release's service worker takes over (public/sw-auto-reload.js),
 * this page reloads into the new version at a moment that interrupts nothing:
 * on the next page change (the reload lands on the page being opened), or
 * once the tab is in the background. A page that was opened before any
 * service worker existed already runs the newest code and doesn't reload.
 */
export function listenForAppUpdates(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const startedUnderServiceWorker = !!navigator.serviceWorker.controller;
  let updatePending = false;

  const reload = () => window.location.reload();

  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type !== "rmroost:app-updated") return;
    if (!startedUnderServiceWorker || updatePending) return;
    updatePending = true;
    if (document.visibilityState === "hidden") reload();
  });

  document.addEventListener("visibilitychange", () => {
    if (updatePending && document.visibilityState === "hidden") reload();
  });

  // On the next in-app navigation, reload at the new address instead.
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method].bind(history);
    history[method] = ((...args: Parameters<History["pushState"]>) => {
      const result = original(...args);
      if (updatePending && method === "pushState") reload();
      return result;
    }) as History["pushState"];
  }
  window.addEventListener("popstate", () => { if (updatePending) reload(); });

  // A page still running an older release can find its code files replaced:
  // load the new release instead of failing.
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    reload();
  });
}
