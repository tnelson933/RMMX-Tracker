import { CLOUD_URL } from "./cloud-url";

/**
 * The organizer's cloud session, shared by auto-sync and the cloud pass-through.
 *
 * Credentials come from the environment (CLOUD_EMAIL / CLOUD_PASSWORD or
 * SYNC_TOKEN, used when the local server runs on its own) or from the desktop
 * app, which hands over the signed-in account at runtime through
 * POST /api/desktop/cloud-credentials. The desktop never passes them as
 * environment variables because those would also start auto-sync.
 */

type Credentials = { email: string; password: string; syncToken: string; cloudUrl: string };

const envCredentials: Credentials = {
  email: process.env.CLOUD_EMAIL ?? "",
  password: process.env.CLOUD_PASSWORD ?? "",
  syncToken: process.env.SYNC_TOKEN ?? "",
  cloudUrl: CLOUD_URL,
};

let runtimeCredentials: Credentials | null = null;
let cachedCookie: string | null = null;
let loginInFlight: Promise<string> | null = null;

function current(): Credentials {
  return runtimeCredentials ?? envCredentials;
}

/** Cloud base URL the session belongs to (no trailing slash). */
export function cloudBaseUrl(): string {
  return current().cloudUrl;
}

/** True when there is something to authenticate the pass-through with. */
export function hasCloudCredentials(): boolean {
  const c = current();
  return !!((c.email && c.password) || c.syncToken);
}

/** Replace the credentials (desktop sign-in) or clear them (null = sign-out). */
export function setRuntimeCloudCredentials(
  creds: { email: string; password: string; cloudUrl?: string } | null,
): void {
  cachedCookie = null;
  loginInFlight = null;
  if (!creds) {
    // Signed out on the desktop: no organizer account to act as.
    runtimeCredentials = { email: "", password: "", syncToken: "", cloudUrl: CLOUD_URL };
    return;
  }
  runtimeCredentials = {
    email: creds.email,
    password: creds.password,
    syncToken: "",
    cloudUrl: (creds.cloudUrl || CLOUD_URL).replace(/\/$/, ""),
  };
}

/** Joins every cookie from a login response into one Cookie header value. */
function cookieHeaderFrom(res: Response): string {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (res.headers.get("set-cookie") ?? "").split(/,(?=\s*[^;,=\s]+=)/);
  return list
    .map((c) => c.trim().split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function login(): Promise<string> {
  const c = current();
  const res = await fetch(`${c.cloudUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: c.email, password: c.password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Login failed (${res.status}): ${body}`);
  }
  await res.body?.cancel().catch(() => {});
  const cookie = cookieHeaderFrom(res);
  if (!cookie) throw new Error("Login succeeded but no session cookie received");
  return cookie;
}

/**
 * Auth headers for a cloud request. Reuses the cached session cookie unless
 * `fresh` is set (after a 401, or when the caller always wants a new login).
 */
export async function getCloudAuthHeader(
  opts: { fresh?: boolean } = {},
): Promise<Record<string, string>> {
  const c = current();
  if (c.email && c.password) {
    if (opts.fresh) cachedCookie = null;
    if (cachedCookie) return { Cookie: cachedCookie };
    if (!loginInFlight) {
      const attempt = login();
      loginInFlight = attempt;
      attempt.then(
        (cookie) => { if (loginInFlight === attempt) cachedCookie = cookie; },
        () => {},
      ).finally(() => { if (loginInFlight === attempt) loginInFlight = null; });
    }
    return { Cookie: await loginInFlight };
  }
  if (c.syncToken) return { Authorization: `Bearer ${c.syncToken}` };
  throw new Error("No cloud credentials configured");
}
