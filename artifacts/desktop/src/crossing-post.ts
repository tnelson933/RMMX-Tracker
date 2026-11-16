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
}

export function buildLocalCrossingPayload(opts: LocalCrossing): Record<string, string> {
  const { tag, fieldName = "rfidNumber", crossingTime, receivedAtUtc, deviceTimezone, source, timeSource, readerId, readerName, readerAddress } = opts;
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

export function postCrossingToLocalServer(
  target: CrossingPostTarget,
  crossing: LocalCrossing,
  callbacks: CrossingPostCallbacks = {},
): void {
  const body = JSON.stringify(buildLocalCrossingPayload(crossing));
  const label = crossing.readerName || "The reader";
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
      if (statusCode >= 400) {
        console.error(`[rfid] crossing rejected: HTTP ${statusCode}`);
        let rejection = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { rejection += chunk; });
        res.on("end", () => {
          // 404/409: the reader works and the read arrived, it just doesn't count
          // (nothing running, the rider's moto is over, a resent read from before
          // the start, an unknown tag). That is not a connection problem, so it
          // must not turn the reader status red.
          if (statusCode === 404 || statusCode === 409) return;
          callbacks.onFailure?.(`${label} read a real crossing, but the local timing server rejected it (HTTP ${statusCode}${rejection ? `: ${rejection}` : ""}).`);
        });
      } else {
        res.resume();
      }
      callbacks.onResponse?.(statusCode);
    },
  );
  req.on("socket", (socket) => socket.setNoDelay(true));

  req.on("error", (err) => {
    console.error(`[rfid] failed to post crossing: ${err.message}`);
    callbacks.onFailure?.(`${label} read a real crossing, but it could not reach the local timing server: ${err.message}`);
  });

  req.write(body);
  req.end();
}
