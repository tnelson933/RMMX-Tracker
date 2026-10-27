/**
 * Cloud server URL for the offline local server.
 *
 * CLOUD_URL comes from the desktop app or the start script. When it is missing,
 * or still points at the retired Replit deployment, the production server is
 * used instead.
 */
export const DEFAULT_CLOUD_URL = "https://www.rmroost.com";

const LEGACY_CLOUD_HOST_SUFFIXES = [".replit.app", ".replit.dev", ".repl.co"];

export function resolveCloudUrl(raw: string | null | undefined): string {
  const trimmed = String(raw ?? "").trim().replace(/\/$/, "");
  if (!trimmed) return DEFAULT_CLOUD_URL;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (LEGACY_CLOUD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      return DEFAULT_CLOUD_URL;
    }
  } catch {
    // Not a URL: keep it so the failure is visible in the logs and status.
  }
  return trimmed;
}

export const CLOUD_URL = resolveCloudUrl(process.env.CLOUD_URL);
