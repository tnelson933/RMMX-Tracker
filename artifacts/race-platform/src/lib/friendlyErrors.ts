/**
 * Plain-language messages for failures that never reach a server-written error:
 * the request couldn't be sent at all, or the server itself failed.
 */

/** True when fetch() failed before any HTTP response (offline, DNS, firewall, blocked domain). */
export function isNetworkError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  return err instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}

export const NETWORK_ERROR_MESSAGE =
  "Can't reach RM Roost from this network. Check that you're connected to the internet. " +
  "On a work or school network, rmroost.com may be blocked: try your phone's data connection, " +
  "or ask your IT team to allow rmroost.com.";

export function serverErrorMessage(status: number): string {
  return `RM Roost's server had a problem (error ${status}). Wait a minute and try again. ` +
    "If it keeps happening, contact Rocky Mountain ATV/MC support and mention this error code.";
}

/**
 * Toast description for a caught error: the server's plain-language message
 * when there is one, the network message when the request never left, and a
 * next step otherwise. Placeholder messages like "Failed" are never shown.
 */
export function errorText(err: unknown): string {
  if (isNetworkError(err)) return NETWORK_ERROR_MESSAGE;
  const msg = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof msg === "string" && msg.trim() && !/^(failed|error)$/i.test(msg.trim())) return msg;
  return "Something went wrong. Refresh the page and try again.";
}

/**
 * Message for a failed fetch() response: the server's own `error` text when it
 * sent one, otherwise a plain-language line for the status. Never "HTTP 500".
 */
export function responseErrorMessage(status: number, body?: unknown): string {
  const serverText = (body as { error?: unknown } | null | undefined)?.error;
  if (typeof serverText === "string" && serverText.trim()) return serverText;
  if (status >= 500) return serverErrorMessage(status);
  if (status === 401) return "You're signed out. Sign in again, then try once more.";
  if (status === 403) return "Your account doesn't have access to this. Ask your club's owner to give you access on the Team page.";
  if (status === 404) return "That item couldn't be found. It may have been deleted. Refresh the page and try again.";
  if (status === 429) return "Too many tries in a short time. Wait a minute, then try again.";
  return `That didn't work (error ${status}). Check what you entered and try again.`;
}
