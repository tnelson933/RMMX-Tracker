/**
 * Request-log URL redaction.
 *
 * Reader tokens are bearer secrets carried in the URL path
 * (/api/timing/readers/:token/...), so they must never reach request logs.
 * Query strings are dropped entirely because some clients (the connector
 * WebSocket, setup links) also carry secrets there.
 */
const READER_TOKEN_PATH = /(\/timing\/readers\/)[^/?#]+/g;

export function redactLogUrl(url: string | undefined): string | undefined {
  if (url == null) return url;
  return url.split("?")[0].replace(READER_TOKEN_PATH, "$1[redacted]");
}
