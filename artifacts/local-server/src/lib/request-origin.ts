import type { Request, RequestHandler } from "express";

// Browser origins allowed to call the local server: the server's own origin
// (the desktop renderer at http://127.0.0.1:<port>, or a LAN device that
// opened the server directly) plus loopback development origins on any port.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

export function isAllowedBrowserOrigin(origin: string, requestHost: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // Includes the opaque "null" origin sent by sandboxed frames and file: pages.
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (isLoopbackHost(url.hostname)) return true;
  // Same-origin page served by this server to a LAN device (e.g. a tablet at
  // http://192.168.1.20:9090). Only IP-literal hosts qualify: matching an
  // arbitrary hostname against Host would let a DNS-rebinding page pass.
  return (
    !!requestHost &&
    url.host.toLowerCase() === requestHost.toLowerCase() &&
    isIpLiteral(url.hostname)
  );
}

export function corsOptionsFor(req: Request) {
  const origin = req.headers.origin;
  return {
    origin: typeof origin === "string" && isAllowedBrowserOrigin(origin, req.headers.host),
    credentials: true,
  };
}

/**
 * Guards hardware crossing-ingest routes. Legitimate callers are timing
 * readers posting JSON directly, the desktop main process and other Node
 * clients; none of them send an Origin header. Readers configured with a URL
 * cannot add a shared-secret header, so instead this rejects what only a web
 * page could send: a foreign Origin or an HTML-form body.
 */
export const rejectForeignBrowserIngest: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === "string" && !isAllowedBrowserOrigin(origin, req.headers.host)) {
    res.status(403).json({ error: "Crossing ingest is not allowed from this origin" });
    return;
  }
  if (req.is("application/x-www-form-urlencoded") || req.is("multipart/form-data")) {
    res.status(415).json({ error: "Crossing ingest requires a JSON body" });
    return;
  }
  next();
};
