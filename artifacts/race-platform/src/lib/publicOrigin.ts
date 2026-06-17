/**
 * Returns the correct public-facing origin for building shareable links.
 *
 * Priority order:
 *  1. VITE_CLOUD_URL — baked into the build by CI (most reliable)
 *  2. window.electronAPI.cloudUrl — injected at runtime by the Electron
 *     preload via synchronous IPC (works for installs that pre-date the
 *     baked-URL feature or when the GitHub CLOUD_URL variable isn't set)
 *  3. window.location.origin — fallback for the cloud web app
 */
export function getPublicOrigin(): string {
  const buildUrl = (import.meta.env.VITE_CLOUD_URL as string | undefined) ?? "";
  if (buildUrl) return buildUrl.replace(/\/$/, "");

  const runtimeUrl =
    typeof window !== "undefined"
      ? ((window as unknown as Record<string, unknown>).electronAPI as Record<string, unknown> | undefined)?.cloudUrl as string | undefined
      : undefined;
  if (runtimeUrl) return runtimeUrl.replace(/\/$/, "");

  return window.location.origin;
}
