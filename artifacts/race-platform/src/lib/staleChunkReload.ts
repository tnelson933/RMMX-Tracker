/**
 * Recovering from code files that are gone.
 *
 * Pages load their code on demand (src/lib/lazyPage.ts). A tab opened before a
 * release still asks for the old release's file names, which the new release
 * no longer has, so the import fails. Reloading once picks up the new release.
 *
 * Reloads at most once per RELOAD_WINDOW_MS (tracked in sessionStorage), and
 * never while offline: there the reload would fail the same way, and a loop of
 * reloads is worse than the "couldn't load this page" message the caller shows.
 */

const RELOAD_KEY = "rmroost:stale-code-reload-at";
const RELOAD_WINDOW_MS = 30_000;

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk \S+ failed|is not a valid JavaScript MIME type/i;

/** An error from loading a code file (as opposed to an error in the page's own code). */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: unknown; message?: unknown };
  return CHUNK_ERROR.test(`${String(e.name ?? "")} ${String(e.message ?? err)}`);
}

/**
 * Reloads the page to pick up the current release. Returns false (and does
 * nothing) when offline, when it already reloaded moments ago, or when the
 * browser won't let it remember that it did (no reload loop either way).
 */
export function reloadForStaleCode(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (last && Date.now() - last < RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

// Idle preloading (lazyPage.ts) downloads pages nobody is looking at yet. A
// failed background download must not reload the page under the visitor; the
// page retries (and recovers) when it's actually opened.
let backgroundLoads = 0;

export function isBackgroundLoading(): boolean {
  return backgroundLoads > 0;
}

export async function inBackground<T>(load: () => Promise<T>): Promise<T> {
  backgroundLoads++;
  try {
    return await load();
  } finally {
    backgroundLoads--;
  }
}
