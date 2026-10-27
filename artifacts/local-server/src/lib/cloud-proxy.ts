import type { Request, RequestHandler, Response } from "express";
import { Readable } from "stream";
import { cloudBaseUrl, getCloudAuthHeader, hasCloudCredentials } from "./cloud-session";

/**
 * Cloud pass-through for /api endpoints the local server does not implement.
 *
 * Mounted after every local router, so a local route always wins. The request
 * is replayed against the cloud API as the desktop's signed-in organizer and
 * the response (status, content type, body; SSE unbuffered) is streamed back.
 * The local session cookie is never forwarded and cloud cookies never reach
 * the browser.
 */

export const OFFLINE_ERROR =
  "This needs an internet connection. It works again when RM Roost is back online.";
const SIGN_IN_ERROR =
  "RM Roost could not sign in to the cloud. Check Cloud Sync Settings, then try again.";

// Request headers worth replaying. Everything else (Cookie, Authorization,
// Origin, Host, Referer, forwarding headers) stays on this machine.
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "last-event-id",
  "range",
];

// Response headers passed back to the browser. Set-Cookie is deliberately absent:
// the cloud session must not replace the local one.
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "content-disposition",
  "etag",
  "last-modified",
  "content-range",
  "accept-ranges",
  "location",
  "retry-after",
];

const CONNECT_TIMEOUT_MS = 20_000;

function isLocallySignedIn(req: Request): boolean {
  return !!(req.session as { userId?: unknown } | undefined)?.userId;
}

/**
 * True when express.json / express.urlencoded read the body. Express 5 leaves
 * req.body undefined when no parser ran; the stream is then still unread.
 */
function bodyWasParsed(req: Request): boolean {
  return req.body !== undefined || req.readableEnded;
}

/** The request body to replay, or undefined for a bodiless request. */
function requestBody(req: Request): { body: string | Readable; duplex?: "half" } | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  // express.json / express.urlencoded already consumed these; re-encode.
  if (bodyWasParsed(req)) {
    if (req.is("application/x-www-form-urlencoded")) {
      return { body: new URLSearchParams(req.body as Record<string, string>).toString() };
    }
    return { body: JSON.stringify(req.body ?? {}) };
  }
  // Anything else (multipart uploads, raw bodies) has not been read: stream it.
  const length = req.headers["content-length"];
  if (length === "0" || (!length && !req.headers["transfer-encoding"])) return undefined;
  return { body: req, duplex: "half" };
}

async function forward(
  req: Request,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<globalThis.Response> {
  const headers: Record<string, string> = { ...auth };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const payload = requestBody(req);
  if (payload && bodyWasParsed(req) && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return fetch(`${cloudBaseUrl()}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: payload?.body as never,
    ...(payload?.duplex ? { duplex: payload.duplex } : {}),
    redirect: "manual",
    signal,
  } as RequestInit);
}

function sendJsonError(res: Response, status: number, error: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error });
}

export const cloudPassThrough: RequestHandler = async (req, res) => {
  // Attach the organizer's cloud session only for a signed-in local user, and
  // never for rider-portal routes (riders authenticate on their own). Anyone
  // else is forwarded anonymously, so only public cloud endpoints answer them.
  const actAsOrganizer = isLocallySignedIn(req) && !req.path.startsWith("/rider/");
  if (actAsOrganizer && !hasCloudCredentials()) {
    sendJsonError(res, 503, OFFLINE_ERROR);
    return;
  }

  // A streamed body can only be sent once, so it is never retried after a 401.
  const canRetry = !(requestBody(req)?.body instanceof Readable);
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  res.on("close", () => controller.abort());

  let upstream: globalThis.Response;
  try {
    let auth: Record<string, string> = {};
    if (actAsOrganizer) auth = await getCloudAuthHeader();
    upstream = await forward(req, auth, controller.signal);
    if (upstream.status === 401 && actAsOrganizer && canRetry) {
      await upstream.body?.cancel().catch(() => {});
      auth = await getCloudAuthHeader({ fresh: true });
      upstream = await forward(req, auth, controller.signal);
    }
  } catch (err) {
    clearTimeout(connectTimer);
    if (controller.signal.aborted && res.writableEnded) return;
    const message = err instanceof Error ? err.message : String(err);
    // A rejected login (bad saved password) is not an outage.
    const status = /^Login failed \((4\d\d)\)/.exec(message);
    if (status) {
      sendJsonError(res, 503, SIGN_IN_ERROR);
    } else {
      console.warn(`[cloud-proxy] ${req.method} ${req.path} failed: ${message}`);
      sendJsonError(res, 503, OFFLINE_ERROR);
    }
    return;
  }
  clearTimeout(connectTimer);

  if (upstream.status === 401 && actAsOrganizer) {
    // Passing the cloud's 401 through would sign the organizer out locally.
    await upstream.body?.cancel().catch(() => {});
    sendJsonError(res, 503, SIGN_IN_ERROR);
    return;
  }

  res.status(upstream.status);
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) res.setHeader(name, value);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.startsWith("text/event-stream")) {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.socket?.setNoDelay(true);
  }

  if (!upstream.body || req.method === "HEAD") {
    res.end();
    return;
  }

  // Stream chunk by chunk (no buffering), so SSE events arrive as they are sent.
  const body = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
  body.on("error", () => {
    if (!res.headersSent) sendJsonError(res, 503, OFFLINE_ERROR);
    else res.end();
  });
  body.pipe(res);
};
