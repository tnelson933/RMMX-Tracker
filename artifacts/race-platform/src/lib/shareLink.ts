/**
 * Shares a link with the phone's share sheet, or copies it where there's none
 * (most desktop browsers). "cancelled" when the viewer closed the share sheet.
 */
export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

export async function shareLink(link: { title: string; text?: string; url: string }): Promise<ShareOutcome> {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  if (nav?.share) {
    try {
      await nav.share(link);
      return "shared";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return "cancelled";
      // Not allowed here (e.g. an embedded frame): fall back to copying.
    }
  }
  try {
    if (nav?.clipboard) {
      await nav.clipboard.writeText(link.url);
      return "copied";
    }
  } catch {
    // Clipboard permission refused (or not a secure page): the older copy below still works in a click.
  }
  return legacyCopy(link.url) ? "copied" : "failed";
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  return ok;
}

/** The shared link for one rider's result on the event page (api-server lib/shareMeta.ts riderResultPath). */
export function riderResultUrl(origin: string, eventId: number, riderId: number): string {
  return `${origin.replace(/\/$/, "")}/results/${eventId}?rider=${riderId}`;
}

/** The ?rider= id from a results-page search string, or null. */
export function riderFromSearch(search: string): number | null {
  const raw = new URLSearchParams(search).get("rider");
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}
