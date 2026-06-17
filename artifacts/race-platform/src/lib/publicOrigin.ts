/**
 * Returns the correct public-facing origin for building shareable links.
 *
 * Priority order:
 *  1. VITE_CLOUD_URL — baked into the build by CI (most reliable)
 *  2. window.electronAPI.getCloudUrl() — called live on every invocation so
 *     it reflects credentials saved after login in the current session.
 *     Falls back to the legacy static .cloudUrl property for older preloads.
 *  3. window.location.origin — fallback for the cloud web app
 */
export function getPublicOrigin(): string {
  const buildUrl = (import.meta.env.VITE_CLOUD_URL as string | undefined) ?? "";
  if (buildUrl) return buildUrl.replace(/\/$/, "");

  if (typeof window !== "undefined") {
    const api = (window as unknown as Record<string, unknown>).electronAPI as Record<string, unknown> | undefined;
    const runtimeUrl =
      typeof api?.getCloudUrl === "function"
        ? (api.getCloudUrl as () => string)()
        : (api?.cloudUrl as string | undefined);
    if (runtimeUrl) return runtimeUrl.replace(/\/$/, "");
  }

  return window.location.origin;
}
