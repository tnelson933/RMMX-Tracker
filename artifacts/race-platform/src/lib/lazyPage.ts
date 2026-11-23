import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { inBackground, isChunkLoadError, reloadForStaleCode } from "./staleChunkReload";

export type LazyPage<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** Starts downloading the page's code without showing it (safe to call repeatedly). */
  preload: () => Promise<unknown>;
};

/**
 * A page whose code downloads the first time it's shown (or preloaded), so a
 * visitor only downloads the pages they open. Render it inside <Suspense>.
 *
 * If the download fails because a new release replaced the files, the page
 * reloads once into the new release; otherwise the error reaches the nearest
 * error boundary (RouteErrorBoundary), which offers a retry.
 */
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyPage<T> {
  let pending: Promise<{ default: T }> | undefined;
  const preload = () => {
    pending ??= load().catch((err) => {
      pending = undefined; // let a later attempt try again
      throw err;
    });
    return pending;
  };
  const Page = lazy(() =>
    preload().then(
      (mod) => {
        // Vite resolves a failed import to undefined after its "vite:preloadError"
        // handler (src/lib/appUpdates.ts) starts a reload: wait for the reload.
        if (!mod) return new Promise<never>(() => {});
        return mod;
      },
      (err) => {
        if (isChunkLoadError(err) && reloadForStaleCode()) return new Promise<never>(() => {});
        throw err;
      },
    ),
  );
  return Object.assign(Page, { preload });
}

/**
 * Preloads pages one after another while the browser is idle, so the next tap
 * opens instantly and (through the service worker's runtime cache) keeps
 * working without signal. Skipped when the visitor asked to save data.
 */
export function preloadWhenIdle(pages: Array<{ preload: () => Promise<unknown> }>): () => void {
  if (typeof window === "undefined") return () => {};
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return () => {};
  let cancelled = false;
  const idle: (cb: () => void) => void =
    "requestIdleCallback" in window
      ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
      : (cb) => window.setTimeout(cb, 1500);
  const next = (i: number) => {
    if (cancelled || i >= pages.length || navigator.onLine === false) return;
    idle(() => {
      if (cancelled) return;
      inBackground(pages[i].preload).catch(() => {}).finally(() => next(i + 1));
    });
  };
  next(0);
  return () => { cancelled = true; };
}
