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
