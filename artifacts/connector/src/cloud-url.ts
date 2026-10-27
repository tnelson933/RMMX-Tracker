/**
 * Cloud URL defaults and migration.
 *
 * The release build bakes the CLOUD_URL repo variable into
 * `__DEFAULT_CLOUD_URL__`. When it is missing (local builds, an unset
 * variable) the connector falls back to the production site so a fresh
 * install works without typing a URL.
 */
declare const __DEFAULT_CLOUD_URL__: string | undefined;

export const FALLBACK_CLOUD_URL = "https://www.rmroost.com";

/** Trim, add https:// when no scheme was typed, and drop trailing slashes. */
export function normalizeCloudUrl(value: unknown): string {
  let url = typeof value === "string" ? value.trim() : "";
  if (!url) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

export function builtInCloudUrl(): string {
  const baked = typeof __DEFAULT_CLOUD_URL__ === "string" ? normalizeCloudUrl(__DEFAULT_CLOUD_URL__) : "";
  // A build made before the move could still carry the retired host.
  return baked && !isRetiredCloudUrl(baked) ? baked : FALLBACK_CLOUD_URL;
}

/** Hosts the platform no longer serves from (the former Replit deployment). */
export function isRetiredCloudUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "replit.app" || host.endsWith(".replit.app") || host.endsWith(".repl.co");
  } catch {
    return false;
  }
}

/**
 * The cloud URL to use for saved settings: empty or retired values become the
 * built-in URL; anything else the organizer chose (e.g. a local server) stays.
 */
export function migrateCloudUrl(saved: unknown, builtIn: string = builtInCloudUrl()): string {
  const url = normalizeCloudUrl(saved);
  if (!url || isRetiredCloudUrl(url)) return builtIn;
  return url;
}
