/**
 * "Recently seen tags" for the live tag scanner (Reader Setup, check-in):
 * every tag a reader on this computer reports, whether or not it matched a
 * rider or a running moto, so an organizer can hold a tag by a reader and read
 * its number. Kept in memory, like the cloud's lib/recentTags.ts.
 */
interface SeenTag { rfidNumber: string; count: number; firstSeenAt: number; lastSeenAt: number }

const MAX_TAGS = 50;
const EXPIRE_MS = 10 * 60 * 1000; // drop tags not seen for 10 minutes
const tags = new Map<string, SeenTag>();

export function recordTagSeen(raw: unknown): void {
  if (typeof raw !== "string" && typeof raw !== "number") return;
  const rfidNumber = String(raw).trim().toUpperCase();
  if (!rfidNumber) return;
  const now = Date.now();
  const existing = tags.get(rfidNumber);
  if (existing) { existing.count += 1; existing.lastSeenAt = now; return; }
  if (tags.size >= MAX_TAGS) {
    let oldest: string | null = null, at = Infinity;
    for (const [k, v] of tags) if (v.lastSeenAt < at) { at = v.lastSeenAt; oldest = k; }
    if (oldest) tags.delete(oldest);
  }
  tags.set(rfidNumber, { rfidNumber, count: 1, firstSeenAt: now, lastSeenAt: now });
}

/** Every tag in a hardware read, whichever payload format the reader used. */
export function recordTagsInPayload(body: any): void {
  if (!body || typeof body !== "object") return;
  recordTagSeen(body.rfidNumber ?? body.transponder ?? body.transponderId ?? body.transponderNumber);
  if (Array.isArray(body.events)) for (const e of body.events) recordTagSeen(e?.tagInventoryEvent?.epcHex);
  const zebra = Array.isArray(body?.data?.tags) ? body.data.tags : Array.isArray(body.tags) ? body.tags : [];
  for (const t of zebra) recordTagSeen(t?.idHex ?? t?.epc);
}

export function getRecentTags(): SeenTag[] {
  const cutoff = Date.now() - EXPIRE_MS;
  for (const [k, v] of tags) if (v.lastSeenAt < cutoff) tags.delete(k);
  return [...tags.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function clearRecentTags(): void { tags.clear(); }

// While someone has the scanner open (the page asks for the list every couple
// of seconds), the RM TrackR loops stay open so a transponder can be read with
// no moto or practice running. They close again shortly after the page stops.
let scannerSeenAt = 0;
export function noteScannerOpen(): void { scannerSeenAt = Date.now(); }
export function scannerOpen(): boolean { return Date.now() - scannerSeenAt < 12_000; }
