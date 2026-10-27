/**
 * Bounded retry queue for crossings the cloud could not accept.
 *
 * A crossing is queued only when the failure is transient: a network error,
 * an HTTP 5xx, or HTTP 429. Business rejections (no moto in progress, unknown
 * reader, validation errors) are final and are not retried. Each entry keeps
 * the original crossing and receipt timestamps, so a delayed delivery is
 * scored at the moment the rider actually crossed.
 *
 * The queue drains in order, one request at a time, and an entry is removed
 * only after the cloud answered it, so a successful send is never repeated by
 * the queue itself. It is persisted to a JSON file so a connector restart
 * during an outage does not lose crossings.
 */
import fs from "fs";
import path from "path";

export interface QueuedCrossing {
  rfidNumber: string;
  /** ISO timestamp of the original crossing. */
  crossingTime: string;
  antennaId?: number | null;
  clubId?: number | null;
  eventId?: number | null;
  /** ISO timestamp of when the connector received the read. */
  receivedAtUtc?: string;
  deviceTimezone?: string | null;
  source?: string;
}

export interface CrossingSendResult {
  ok: boolean;
  status?: number;
  message?: string;
}

interface QueueEntry {
  crossing: QueuedCrossing;
  /** Failed sends so far; drives the backoff delay. */
  attempts: number;
  /** Failed sends the cloud answered with 5xx/429. Network errors don't count,
   *  so a long outage never exhausts this; a persistently failing entry does. */
  serverErrors?: number;
  queuedAt: string;
}

export interface CrossingRetryQueueOptions {
  send: (crossing: QueuedCrossing) => Promise<CrossingSendResult>;
  /** JSON file used to persist the queue; null keeps it in memory only. */
  filePath?: string | null;
  maxEntries?: number;
  /** Drop an entry after this many 5xx/429 answers (network errors excluded). */
  maxServerErrors?: number;
  maxAgeMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  onChange?: () => void;
  log?: (message: string) => void;
}

/** Transient failures worth retrying: no HTTP answer, 5xx, or 429. */
export function isRetryableCrossingResult(result: CrossingSendResult): boolean {
  if (result.ok) return false;
  if (result.status === undefined) return false;
  return result.status === 429 || result.status >= 500;
}

export class CrossingRetryQueue {
  private entries: QueueEntry[] = [];
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private readonly send: CrossingRetryQueueOptions["send"];
  private readonly filePath: string | null;
  private readonly maxEntries: number;
  private readonly maxServerErrors: number;
  private readonly maxAgeMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly log: (message: string) => void;

  constructor(opts: CrossingRetryQueueOptions) {
    this.send = opts.send;
    this.filePath = opts.filePath ?? null;
    this.maxEntries = opts.maxEntries ?? 2_000;
    this.maxServerErrors = opts.maxServerErrors ?? 20;
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
    this.baseDelayMs = opts.baseDelayMs ?? 2_000;
    this.maxDelayMs = opts.maxDelayMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
    this.log = opts.log ?? ((message) => console.warn(`[crossing-queue] ${message}`));
  }

  get size(): number {
    return this.entries.length;
  }

  /** Load persisted entries (if any) and start draining them. */
  load(): void {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as { entries?: unknown };
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.entries = entries
        .filter((e): e is QueueEntry => {
          const c = (e as QueueEntry | null)?.crossing;
          return !!c && typeof c.rfidNumber === "string" && typeof c.crossingTime === "string";
        })
        .slice(-this.maxEntries);
    } catch (err) {
      this.log(`could not read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
      this.entries = [];
    }
    if (this.entries.length > 0) {
      this.log(`restored ${this.entries.length} undelivered crossing(s)`);
      this.schedule(0);
    }
  }

  /**
   * Queue a crossing. `attempts` is how many sends already failed (0 when it
   * is queued behind a backlog without being tried, so order is preserved).
   */
  enqueue(crossing: QueuedCrossing, attempts: number): void {
    this.entries.push({ crossing, attempts, queuedAt: new Date(this.now()).toISOString() });
    if (this.entries.length > this.maxEntries) {
      const dropped = this.entries.splice(0, this.entries.length - this.maxEntries);
      this.log(`queue full — dropped ${dropped.length} oldest crossing(s)`);
    }
    this.persist();
    this.onChange();
    if (attempts > 0) this.schedule(this.delayFor(attempts));
    else this.schedule(0);
  }

  /** Retry now (e.g. the cloud link reconnected), skipping any backoff. */
  retryNow(): void {
    if (this.entries.length === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.drain();
  }

  /** Stop the retry timer. Entries stay persisted for the next start. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private delayFor(attempts: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(0, attempts - 1), this.maxDelayMs);
  }

  /** Schedule a drain unless one is already pending or running. */
  private schedule(delayMs: number): void {
    if (this.draining || this.timer || this.entries.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let retryDelay: number | null = null;
    try {
      while (this.entries.length > 0) {
        const head = this.entries[0];
        if (this.now() - Date.parse(head.queuedAt) > this.maxAgeMs) {
          this.entries.shift();
          this.log(`dropped crossing ${head.crossing.rfidNumber} @ ${head.crossing.crossingTime}: too old`);
          this.persist();
          continue;
        }

        let result: CrossingSendResult;
        let retryable: boolean;
        let networkError = false;
        try {
          result = await this.send(head.crossing);
          retryable = isRetryableCrossingResult(result);
        } catch (err) {
          result = { ok: false, message: err instanceof Error ? err.message : String(err) };
          retryable = true;
          networkError = true;
        }

        if (!retryable) {
          // Delivered, or a final rejection the cloud will never accept.
          this.entries.shift();
          if (!result.ok) {
            this.log(`cloud rejected queued crossing ${head.crossing.rfidNumber} @ ${head.crossing.crossingTime}` +
              `${result.status ? ` (HTTP ${result.status})` : ""}${result.message ? `: ${result.message}` : ""}`);
          }
          this.persist();
          continue;
        }

        head.attempts++;
        if (!networkError) head.serverErrors = (head.serverErrors ?? 0) + 1;
        if ((head.serverErrors ?? 0) >= this.maxServerErrors) {
          this.entries.shift();
          this.log(`gave up on crossing ${head.crossing.rfidNumber} @ ${head.crossing.crossingTime} after ${head.serverErrors} server errors`);
          this.persist();
          continue;
        }
        this.persist();
        // The cloud is still unreachable; back off before trying again.
        retryDelay = this.delayFor(head.attempts);
        break;
      }
    } finally {
      this.draining = false;
      this.onChange();
    }
    if (retryDelay !== null) this.schedule(retryDelay);
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      if (this.entries.length === 0) {
        if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
        return;
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.log(`could not persist queue: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
