// Small helpers that make offline responses equal the website's for the same
// data. Each mirrors a cloud helper; keep them in step with the file named.
import { getDb } from "../db";

type Db = ReturnType<typeof getDb>;

/**
 * A stored timestamp the way the website's API sends it (ISO 8601, UTC).
 * Rows pulled from the cloud already are; rows made here with SQLite's
 * datetime('now') are "YYYY-MM-DD HH:MM:SS" in UTC.
 */
export function isoTime(value: unknown): string | null {
  if (value == null || value === "") return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(" ", "T")}.000Z`;
  return s;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/** api-server/src/lib/quickCheckinRequirements.ts: every unset requirement is on. */
export function quickCheckinRequirements(stored: unknown) {
  const out = { paid: true, timing: true, waiver: true, pickup: true, atTrack: true };
  const value = parseJson<Record<string, unknown> | null>(stored, null);
  if (value && typeof value === "object") {
    for (const key of Object.keys(out) as Array<keyof typeof out>) {
      if (typeof value[key] === "boolean") out[key] = value[key] as boolean;
    }
  }
  return out;
}

export interface TimingTags {
  transponder: boolean;
  rfid: boolean;
  fromReaders: boolean;
  offered: { transponder: boolean; rfid: boolean };
}

/** api-server/src/lib/eventTimingTags.ts timingTagsFromReaders. */
function timingTagsFromReaders(sources: Array<Array<string | null>>): TimingTags {
  const all = sources.flat();
  const offered = all.length > 0
    ? { transponder: all.includes("active_transponder"), rfid: all.some(t => t !== "active_transponder") }
    : { transponder: true, rfid: true };
  const types = sources.find(list => list.length > 0);
  if (types) {
    return { transponder: types.includes("active_transponder"), rfid: types.some(t => t !== "active_transponder"), fromReaders: true, offered };
  }
  return { transponder: true, rfid: true, fromReaders: false, offered };
}

/**
 * Which kinds of tag each event's readers use (api-server eventsTimingTags):
 * the event's own course map, else its track's course map, else every reader
 * the club has. The check-in screen picks its Sell/Assign buttons from this.
 */
export function eventsTimingTags(db: Db, eventIds: number[]): Map<number, TimingTags> {
  const out = new Map<number, TimingTags>();
  const readerType = new Map<number, string | null>();
  const readersByClub = new Map<number, Array<string | null>>();
  for (const r of db.prepare("SELECT id, club_id, type FROM readers").all() as Array<{ id: number; club_id: number; type: string | null }>) {
    readerType.set(r.id, r.type);
    readersByClub.set(r.club_id, [...(readersByClub.get(r.club_id) ?? []), r.type]);
  }
  const eventRow = db.prepare("SELECT id, club_id, track_id FROM events WHERE id = ?");
  const assigned = db.prepare("SELECT reader_id FROM event_reader_assignments WHERE event_id = ?");
  const track = db.prepare("SELECT course FROM tracks WHERE id = ?");
  for (const id of new Set(eventIds)) {
    const e = eventRow.get(id) as { id: number; club_id: number; track_id: number | null } | undefined;
    if (!e) continue;
    const known = (ids: number[]) => ids.filter(rid => readerType.has(rid)).map(rid => readerType.get(rid) ?? null);
    const eventTypes = known((assigned.all(id) as Array<{ reader_id: number }>).map(a => a.reader_id));
    const course = e.track_id != null
      ? parseJson<Array<{ readerId: number }>>((track.get(e.track_id) as { course: string | null } | undefined)?.course, [])
      : [];
    out.set(id, timingTagsFromReaders([eventTypes, known(course.map(p => Number(p.readerId))), readersByClub.get(e.club_id) ?? []]));
  }
  return out;
}

export function eventTimingTags(db: Db, eventId: number): TimingTags {
  return eventsTimingTags(db, [eventId]).get(eventId)
    ?? { transponder: true, rfid: true, fromReaders: false, offered: { transponder: true, rfid: true } };
}
