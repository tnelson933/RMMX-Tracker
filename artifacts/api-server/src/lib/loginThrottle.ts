import type { Request, Response } from "express";

// Limits password guessing on sign-in. Failures are counted per account (email)
// and per network address; a correct password clears the account's count.
// Kept in memory: the API runs as a single instance, and a restart only resets
// the counters.

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_ACCOUNT = 5;
const MAX_FAILURES_PER_ADDRESS = 30;

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
  const addressFailures = recent(byAddress.get(req.ip ?? "unknown"), now);
  const blocked =
    accountFailures.length >= MAX_FAILURES_PER_ACCOUNT ? accountFailures :
    addressFailures.length >= MAX_FAILURES_PER_ADDRESS ? addressFailures : null;
  if (!blocked) return false;

  const retryMs = WINDOW_MS - (now - blocked[0]);
  const minutes = Math.max(1, Math.ceil(retryMs / 60_000));
  res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
  res.status(429).json({
    error: `Too many sign-in attempts. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again, or reset your password.`,
  });
  return true;
}

export function recordFailedLogin(req: Request, scope: string, email: unknown): void {
  const now = Date.now();
  for (const [map, key] of [[byAccount, accountKey(scope, email)], [byAddress, req.ip ?? "unknown"]] as const) {
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
