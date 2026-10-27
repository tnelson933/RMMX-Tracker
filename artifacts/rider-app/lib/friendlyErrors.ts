/**
 * Plain-language messages for sign-in failures that never reach a server-written
 * error: no connection at all, or the server itself failing.
 */

export const NETWORK_ERROR_MESSAGE =
  "Can't reach RM Roost. Check that you have signal or Wi-Fi. " +
  "On a work or school Wi-Fi, rmroost.com may be blocked: switch to cellular data and try again.";

export function serverErrorMessage(status: number): string {
  return `RM Roost's server had a problem (error ${status}). Wait a minute and try again. ` +
    "If it keeps happening, contact Rocky Mountain ATV/MC support and mention this error code.";
}

/**
 * POST JSON and return the parsed body, turning every failure into a message
 * that says what happened and what to do.
 */
export async function postJson(url: string, body: unknown, fallback: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
  if (res.status >= 500) throw new Error(serverErrorMessage(res.status));
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // A captive portal or network filter answered instead of RM Roost.
    throw new Error(res.ok ? NETWORK_ERROR_MESSAGE : `${fallback} (error ${res.status}).`);
  }
  if (!res.ok) throw new Error(data?.error ?? `${fallback} (error ${res.status}).`);
  return data;
}
