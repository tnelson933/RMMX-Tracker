/**
 * Returns the correct public-facing origin for building shareable links.
 *
 * On the desktop app the page runs at http://127.0.0.1:9090, so
 * window.location.origin would produce broken links. VITE_CLOUD_URL is
 * baked into desktop builds at CI time — prefer it when present.
 *
 * On the cloud web app VITE_CLOUD_URL is not set, so we fall back to
 * window.location.origin as before.
 */
export function getPublicOrigin(): string {
  const cloudUrl = (import.meta.env.VITE_CLOUD_URL as string | undefined) ?? "";
  if (cloudUrl) return cloudUrl.replace(/\/$/, "");
  return window.location.origin;
}
