import http from "http";

// Sends tag and transponder reads to the desktop's local timing server.
// No Electron imports: shared by the main process and plain Node tests.

export interface LocalCrossing {
  tag: string;
  fieldName?: "rfidNumber" | "transponder";
  crossingTime?: Date;
  receivedAtUtc?: string;
  deviceTimezone?: string | null;
  source?: string;
  timeSource?: string;
  /** Stable id of the reader that made the read (enduro gates, split and sector readers). */
  readerId?: string;
  readerName?: string;
  /** The reader's network address, to match it to the club's reader list when names differ. */
  readerAddress?: string;
  /** RFID antenna port that saw the tag (enduro gates and time checks match on it). */
  antennaId?: number | null;
}

export function buildLocalCrossingPayload(opts: LocalCrossing): Record<string, string> {
  const { tag, fieldName = "rfidNumber", crossingTime, receivedAtUtc, deviceTimezone, source, timeSource, readerId, readerName, readerAddress, antennaId } = opts;
  const payload: Record<string, string> = {
    [fieldName]: tag,
    crossingTime: (crossingTime ?? new Date()).toISOString(),
  };
  if (receivedAtUtc) payload.receivedAtUtc = receivedAtUtc;
  if (receivedAtUtc) payload.readerReceivedAt = receivedAtUtc;
  if (deviceTimezone) payload.deviceTimezone = deviceTimezone;
  if (source) payload.source = source;
  if (timeSource) payload.timeSource = timeSource;
  if (readerId) payload.readerId = readerId;
  if (readerName) payload.readerName = readerName;
  if (readerAddress) payload.readerAddress = readerAddress;
  if (antennaId != null && Number.isFinite(antennaId)) payload.antennaId = String(antennaId);
  return payload;
}

export interface CrossingPostTarget {
  port: number;
  host?: string;
  agent?: http.Agent;
}

export interface CrossingPostCallbacks {
  /**
   * The read could not be recorded because of a real problem (server failure,
   * local server unreachable). Never called for HTTP 404/409.
   */
  onFailure?: (message: string) => void;
  /** The local server answered (any status). */
  onResponse?: (statusCode: number) => void;
}

// ── Retry queue ────────────────────────────────────────────────────────────────
// Like RM Connect (connector/src/crossing-retry-queue.ts): a read the local server
// couldn't take because of a passing problem (no answer, HTTP 5xx or 429) is kept
// and resent in order with its original crossing and receipt times, so a local
// server restart or stall mid-moto doesn't lose laps. Rejections (404/409/other
// 4xx) are final. Reads arriving while older ones wait queue behind them.

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;
const RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RETRY_MAX_ENTRIES = 5_000;
const RETRY_MAX_SERVER_ERRORS = 20;

interface QueuedPost {
  target: CrossingPostTarget;
  crossing: LocalCrossing;
  callbacks: CrossingPostCallbacks;
  queuedAt: number;
  attempts: number;
  serverErrors: number;
}

type SendOutcome = { kind: "done" } | { kind: "retry"; serverError: boolean; message: string };

const queue: QueuedPost[] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;

/** Reads waiting to reach the local timing server (for status displays and tests). */
export function pendingCrossingCount(): number {
  return queue.length;
}

function scheduleDrain(delayMs: number): void {
  if (retryTimer || draining) return;
  retryTimer = setTimeout(() => { retryTimer = null; void drain(); }, delayMs);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const entry = queue[0];
      const label = entry.crossing.readerName || "The reader";
      if (Date.now() - entry.queuedAt > RETRY_MAX_AGE_MS || entry.serverErrors >= RETRY_MAX_SERVER_ERRORS) {
        queue.shift();
        entry.callbacks.onFailure?.(`${label} read a real crossing, but the local timing server never accepted it, so it was dropped.`);
        continue;
      }
      const outcome = await sendOnce(entry.target, entry.crossing, entry.callbacks);
      if (outcome.kind === "done") { queue.shift(); continue; }
      entry.attempts++;
      if (outcome.serverError) entry.serverErrors++;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(entry.attempts - 1, 4));
      draining = false;
      scheduleDrain(delay);
      return;
    }
  } finally {
    draining = false;
  }
}

function sendOnce(target: CrossingPostTarget, crossing: LocalCrossing, callbacks: CrossingPostCallbacks): Promise<SendOutcome> {
  const body = JSON.stringify(buildLocalCrossingPayload(crossing));
  const label = crossing.readerName || "The reader";
  return new Promise<SendOutcome>((resolve) => {
  let settled = false;
  const finish = (outcome: SendOutcome) => { if (!settled) { settled = true; resolve(outcome); } };
  const req = http.request(
    {
      host: target.host ?? "127.0.0.1",
      port: target.port,
      path: "/api/timing/active/crossing",
      method: "POST",
      agent: target.agent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      const statusCode = res.statusCode ?? 0;
      callbacks.onResponse?.(statusCode);
      if (statusCode >= 400) {
        console.error(`[crossing] rejected: HTTP ${statusCode}`);
        let rejection = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { rejection += chunk; });
        res.on("end", () => {
          // 404/409: the reader works and the read arrived, it just doesn't count
          // (nothing running, the rider's moto is over, a resent read from before
          // the start, an unknown tag). That is not a connection problem, so it
          // must not turn the reader status red.
          if (statusCode === 404 || statusCode === 409) return finish({ kind: "done" });
          const message = `${label} read a real crossing, but the local timing server rejected it (HTTP ${statusCode}${rejection ? `: ${rejection}` : ""}).`;
          if (statusCode >= 500 || statusCode === 429) {
            return finish({ kind: "retry", serverError: true, message: `${message} Retrying…` });
          }
          callbacks.onFailure?.(message);
          finish({ kind: "done" });
        });
        res.on("error", () => finish({ kind: "retry", serverError: false, message: `${label} read a real crossing, but the answer from the local timing server was cut off. Retrying…` }));
      } else {
        res.resume();
        finish({ kind: "done" });
      }
    },
  );
  req.on("socket", (socket) => socket.setNoDelay(true));
  req.setTimeout(10_000, () => req.destroy(new Error("no answer within 10 seconds")));

  req.on("error", (err) => {
    console.error(`[crossing] could not post: ${err.message}`);
    finish({ kind: "retry", serverError: false, message: `${label} read a real crossing, but it could not reach the local timing server: ${err.message}. Retrying…` });
  });

  req.write(body);
  req.end();
  });
}

/**
 * Sends a read to the local timing server. A read that can't be delivered right
 * now is kept and retried in order (see the retry queue above); onFailure reports
 * it once so the reader can show the problem.
 */
export function postCrossingToLocalServer(
  target: CrossingPostTarget,
  crossing: LocalCrossing,
  callbacks: CrossingPostCallbacks = {},
): void {
  // Pin the crossing time now, so a retried read keeps the moment it was made.
  const pinned: LocalCrossing = { ...crossing, crossingTime: crossing.crossingTime ?? new Date() };
  if (queue.length > 0 || draining) {
    queue.push({ target, crossing: pinned, callbacks, queuedAt: Date.now(), attempts: 0, serverErrors: 0 });
    if (queue.length > RETRY_MAX_ENTRIES) queue.splice(0, queue.length - RETRY_MAX_ENTRIES);
    scheduleDrain(0);
    return;
  }
  void sendOnce(target, pinned, callbacks).then((outcome) => {
    if (outcome.kind === "done") return;
    callbacks.onFailure?.(outcome.message);
    queue.unshift({ target, crossing: pinned, callbacks, queuedAt: Date.now(), attempts: 1, serverErrors: outcome.serverError ? 1 : 0 });
    scheduleDrain(RETRY_BASE_MS);
  });
}
