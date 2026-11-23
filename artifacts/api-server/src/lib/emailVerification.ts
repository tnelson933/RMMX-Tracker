import { createHash, randomInt, timingSafeEqual } from "crypto";

/**
 * Rider account email verification: a 6-digit code, emailed, stored only as a
 * hash, valid for 15 minutes and for 5 tries. The pure rules live here (tested in
 * emailVerification.test.ts); rider-portal.ts does the reads and writes.
 */

export const CODE_TTL_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

/** A random 6-digit code ("000000"-"999999"). */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The stored form of a code: tied to the account so a hash can't be reused on another. */
export function hashCode(accountId: number, code: string): string {
  return createHash("sha256").update(`rider-email-verify:${accountId}:${code}`).digest("hex");
}

/** "123 456", " 123456 " -> "123456"; anything that isn't 6 digits -> null. */
export function normalizeCode(input: unknown): string | null {
  const digits = String(input ?? "").replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export type CodeCheck =
  | { ok: true }
  | { ok: false; reason: "none" | "expired" | "locked" }
  | { ok: false; reason: "wrong"; attemptsLeft: number };

/**
 * Check a typed code against the pending one. `attempts` counts this try
 * (the caller reserves the try before checking, so parallel guesses can't
 * exceed the limit).
 */
export function checkCode(
  pending: { accountId: number; codeHash: string | null; expiresAt: Date | null; attempts: number },
  code: string,
  now: Date = new Date(),
): CodeCheck {
  if (!pending.codeHash || !pending.expiresAt) return { ok: false, reason: "none" };
  if (pending.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (pending.attempts > MAX_CODE_ATTEMPTS) return { ok: false, reason: "locked" };
  const a = Buffer.from(hashCode(pending.accountId, code), "hex");
  const b = Buffer.from(pending.codeHash, "hex");
  if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  const attemptsLeft = Math.max(0, MAX_CODE_ATTEMPTS - pending.attempts);
  return attemptsLeft === 0 ? { ok: false, reason: "locked" } : { ok: false, reason: "wrong", attemptsLeft };
}

/** What a rider reads for each failed check. */
export function codeCheckMessage(result: Exclude<CodeCheck, { ok: true }>): string {
  switch (result.reason) {
    case "none":
      return "There's no code waiting for this account. Tap Resend code to get one.";
    case "expired":
      return "That code has expired (codes last 15 minutes). Tap Resend code to get a new one.";
    case "locked":
      return "Too many wrong codes. Tap Resend code to get a new one.";
    case "wrong":
      return `That code isn't right. Check the latest email from RM Roost and try again (${result.attemptsLeft} ${result.attemptsLeft === 1 ? "try" : "tries"} left).`;
  }
}

/**
 * Counts emails sent per key (an account, an email address or a caller's
 * address) in memory. The API runs as one instance; a restart only resets it.
 */
export class SendLimiter {
  private sent = new Map<string, number[]>();
  constructor(private readonly limits: Array<{ max: number; windowMs: number }>) {}

  /** Milliseconds until `key` may send again (0 = now). */
  waitMs(key: string, now: number = Date.now()): number {
    const times = this.sent.get(key) ?? [];
    let wait = 0;
    for (const { max, windowMs } of this.limits) {
      const recent = times.filter(t => now - t < windowMs);
      if (recent.length >= max) wait = Math.max(wait, windowMs - (now - recent[recent.length - max]));
    }
    return wait;
  }

  /** Records a send for `key` and returns 0, or returns the wait and records nothing. */
  take(key: string, now: number = Date.now()): number {
    const wait = this.waitMs(key, now);
    if (wait > 0) return wait;
    const longest = Math.max(...this.limits.map(l => l.windowMs));
    const times = (this.sent.get(key) ?? []).filter(t => now - t < longest);
    times.push(now);
    this.sent.set(key, times);
    return 0;
  }

  /** Drop keys with nothing recent, so the map doesn't grow without bound. */
  prune(now: number = Date.now()): void {
    const longest = Math.max(...this.limits.map(l => l.windowMs));
    for (const [key, times] of this.sent) if (!times.some(t => now - t < longest)) this.sent.delete(key);
  }
}

/** "Wait 1 minute" / "Wait 12 minutes". */
export function waitText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `Wait ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Verification codes: 1 a minute and 5 an hour per account. */
export const verificationCodeSends = new SendLimiter([{ max: 1, windowMs: 60_000 }, { max: 5, windowMs: 60 * 60_000 }]);
/** Password reset and setup emails: per email address and per caller's address. */
export const resetEmailSendsByEmail = new SendLimiter([{ max: 1, windowMs: 60_000 }, { max: 5, windowMs: 60 * 60_000 }]);
export const resetEmailSendsByAddress = new SendLimiter([{ max: 20, windowMs: 60 * 60_000 }]);

setInterval(() => {
  for (const l of [verificationCodeSends, resetEmailSendsByEmail, resetEmailSendsByAddress]) l.prune();
}, 10 * 60_000).unref();
