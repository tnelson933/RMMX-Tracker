import type { Request, Response } from "express";

// Limits password guessing on sign-in. Kept in memory: the API runs as a single
// instance, and a restart only resets the counters.
//
// Gentle on purpose, and scoped so a stranger can't lock a real organizer out:
//   - 10 wrong passwords for one account from one address in 5 minutes pauses
//     that account on that address only (someone else typing your email
//     elsewhere doesn't stop you);
//   - 100 for one account from anywhere is a backstop against wide guessing;
//   - 50 from one address (any accounts) slows sweeping many accounts.
// A correct password clears the account's counts.
const WINDOW_MS = 5 * 60_000;
const MAX_FAILURES_PER_ACCOUNT_AND_ADDRESS = 10;
const MAX_FAILURES_PER_ACCOUNT = 100;
const MAX_FAILURES_PER_ADDRESS = 50;

/**
 * The caller's address: the proxy's view plus the visitor address Cloudflare
 * forwards (req.ip alone is a Cloudflare edge shared by many organizers). A
 * forged header can't move a caller out of its real address.
 */
function clientAddress(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  return `${req.ip ?? "unknown"}|${typeof cf === "string" ? cf.trim() : ""}`;
}

type Bucket = { failures: number[] };
const byAccount = new Map<string, Bucket>();
const byAccountAndAddress = new Map<string, Bucket>();
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
  const account = accountKey(scope, email);
  const address = clientAddress(req);
  const checks: Array<[number[], number]> = [
    [recent(byAccountAndAddress.get(`${account}@${address}`), now), MAX_FAILURES_PER_ACCOUNT_AND_ADDRESS],
    [recent(byAccount.get(account), now), MAX_FAILURES_PER_ACCOUNT],
    [recent(byAddress.get(address), now), MAX_FAILURES_PER_ADDRESS],
  ];
  const blocked = checks.find(([failures, max]) => failures.length >= max)?.[0];
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
  const account = accountKey(scope, email);
  const address = clientAddress(req);
  for (const [map, key] of [[byAccountAndAddress, `${account}@${address}`], [byAccount, account], [byAddress, address]] as const) {
    const failures = recent(map.get(key), now);
    failures.push(now);
    map.set(key, { failures });
  }
}

export function clearFailedLogins(scope: string, email: unknown): void {
  const account = accountKey(scope, email);
  byAccount.delete(account);
  for (const key of byAccountAndAddress.keys()) if (key.startsWith(`${account}@`)) byAccountAndAddress.delete(key);
}

// Drop expired entries so the maps don't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const map of [byAccount, byAccountAndAddress, byAddress]) {
    for (const [key, bucket] of map) {
      if (recent(bucket, now).length === 0) map.delete(key);
    }
  }
}, WINDOW_MS).unref();
