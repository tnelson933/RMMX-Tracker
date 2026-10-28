import type { Request, Response } from "express";

// Limits password guessing on sign-in. Failures are counted per account (email)
// and per network address; a correct password clears the account's count.
// Kept in memory: the API runs as a single instance, and a restart only resets
// the counters.

// Gentle on purpose: a real organizer mistyping a password never waits; only
// sustained guessing (10+ wrong passwords on one account in 5 minutes) pauses
// that account briefly.
const WINDOW_MS = 5 * 60_000;
const MAX_FAILURES_PER_ACCOUNT = 10;
const MAX_FAILURES_PER_ADDRESS = 50;

/**
 * The caller's own address. Behind Cloudflare, req.ip is a Cloudflare edge
 * shared by many organizers, so use the visitor address Cloudflare forwards.
 */
function clientAddress(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  return (typeof cf === "string" && cf.trim()) || req.ip || "unknown";
}

type Bucket = { failures: number[] };
const byAccount = new Map<string, Bucket>();
const byAddress = new Map<string, Bucket>();

function recent(bucket: Bucket | undefined, now: number): number[] {
  return bucket ? bucket.failures.filter((t) => now - t < WINDOW_MS) : [];
}

function accountKey(scope: string, email: unknown): string {
  return `${scope}:${String(email ?? "").toLowerCase().trim()}`;
}

/**
 * Sends 429 and returns true when this sign-in attempt must wait. Call before
 * checking the password.
 */
export function rejectIfThrottled(req: Request, res: Response, scope: string, email: unknown): boolean {
  const now = Date.now();
  const accountFailures = recent(byAccount.get(accountKey(scope, email)), now);
  const addressFailures = recent(byAddress.get(clientAddress(req)), now);
  const blocked =
    accountFailures.length >= MAX_FAILURES_PER_ACCOUNT ? accountFailures :
    addressFailures.length >= MAX_FAILURES_PER_ADDRESS ? addressFailures : null;
  if (!blocked) return false;

  const retryMs = WINDOW_MS - (now - blocked[0]);
  const minutes = Math.max(1, Math.ceil(retryMs / 60_000));
  res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
  res.status(429).json({
    error: `Too many wrong passwords in a row. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again, or use "Forgot your password?" to reset it.`,
  });
  return true;
}

export function recordFailedLogin(req: Request, scope: string, email: unknown): void {
  const now = Date.now();
  for (const [map, key] of [[byAccount, accountKey(scope, email)], [byAddress, clientAddress(req)]] as const) {
    const failures = recent(map.get(key), now);
    failures.push(now);
    map.set(key, { failures });
  }
}

export function clearFailedLogins(scope: string, email: unknown): void {
  byAccount.delete(accountKey(scope, email));
}

// Drop expired entries so the maps don't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const map of [byAccount, byAddress]) {
    for (const [key, bucket] of map) {
      if (recent(bucket, now).length === 0) map.delete(key);
    }
  }
}, WINDOW_MS).unref();
