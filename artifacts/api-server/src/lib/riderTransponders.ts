import { db, ridersTable, riderTranspondersTable } from "@workspace/db";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { effectiveVisibility } from "./riderResume";
import {
  normalizeTransponderNumber,
  toTransponderViews,
  transponderTakenMessage,
  type RiderTransponderView,
  type TransponderKind,
  type TransponderOwner,
} from "./riderTransponderRules";

export * from "./riderTransponderRules";

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The rider who owns this transponder number: the rider_transponders list
 * (every RM TrackR / sticker a rider owns), then the single profile fields
 * (riders.mylaps_transponder_id / rfid_number) kept for the transition.
 * Case-insensitive. Event-level matches (registrations, rfid_assignments,
 * group-race teams) are the caller's job and come first.
 */
export async function riderIdForTransponder(tag: string): Promise<number | null> {
  const number = normalizeTransponderNumber(tag);
  if (!number) return null;
  const [listed] = await db.select({ riderId: riderTranspondersTable.riderId })
    .from(riderTranspondersTable)
    .where(eq(riderTranspondersTable.transponderNumber, number))
    .limit(1);
  if (listed) return listed.riderId;
  const [legacy] = await db.select({ id: ridersTable.id })
    .from(ridersTable)
    .where(or(ilike(ridersTable.rfidNumber, number), ilike(ridersTable.mylapsTransponderId, number)))
    .orderBy(asc(ridersTable.id))
    .limit(1);
  return legacy?.id ?? null;
}

/** Owners of several numbers at once (normalized number -> rider id), list first then profile fields. */
export async function riderIdsForTransponders(tags: string[]): Promise<Map<string, number>> {
  const numbers = [...new Set(tags.map(normalizeTransponderNumber).filter((n): n is string => !!n))];
  const out = new Map<string, number>();
  if (numbers.length === 0) return out;
  const listed = await db.select({ riderId: riderTranspondersTable.riderId, number: riderTranspondersTable.transponderNumber })
    .from(riderTranspondersTable)
    .where(inArray(riderTranspondersTable.transponderNumber, numbers));
  for (const row of listed) out.set(row.number, row.riderId);
  const missing = numbers.filter((n) => !out.has(n));
  if (missing.length) {
    const legacy = await db.select({ id: ridersTable.id, rfid: ridersTable.rfidNumber, trackr: ridersTable.mylapsTransponderId })
      .from(ridersTable)
      .where(or(...missing.flatMap((n) => [ilike(ridersTable.rfidNumber, n), ilike(ridersTable.mylapsTransponderId, n)])))
      .orderBy(asc(ridersTable.id));
    for (const r of legacy) {
      for (const v of [r.rfid, r.trackr]) {
        const n = normalizeTransponderNumber(v);
        if (n && missing.includes(n) && !out.has(n)) out.set(n, r.id);
      }
    }
  }
  return out;
}

/** Every number each rider owns (normalized), for lookups that start from riders. */
export async function transponderNumbersByRider(riderIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>(riderIds.map((id) => [id, []]));
  if (riderIds.length === 0) return out;
  const rows = await db.select({ riderId: riderTranspondersTable.riderId, number: riderTranspondersTable.transponderNumber })
    .from(riderTranspondersTable)
    .where(inArray(riderTranspondersTable.riderId, riderIds))
    .orderBy(asc(riderTranspondersTable.id));
  for (const r of rows) out.get(r.riderId)?.push(r.number);
  return out;
}

export async function listRiderTransponders(riderId: number): Promise<RiderTransponderView[]> {
  return (await listTranspondersForRiders([riderId])).get(riderId) ?? [];
}

export async function listTranspondersForRiders(riderIds: number[]): Promise<Map<number, RiderTransponderView[]>> {
  const out = new Map<number, RiderTransponderView[]>(riderIds.map((id) => [id, []]));
  if (riderIds.length === 0) return out;
  const rows = await db.select().from(riderTranspondersTable)
    .where(inArray(riderTranspondersTable.riderId, riderIds))
    .orderBy(asc(riderTranspondersTable.id));
  const grouped = new Map<number, typeof rows>();
  for (const r of rows) grouped.set(r.riderId, [...(grouped.get(r.riderId) ?? []), r]);
  for (const [id, list] of grouped) out.set(id, toTransponderViews(list));
  return out;
}

async function ownerOf(number: string): Promise<(TransponderOwner & { kind: TransponderKind }) | null> {
  const [row] = await db.select({
    riderId: riderTranspondersTable.riderId,
    kind: riderTranspondersTable.kind,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    dateOfBirth: ridersTable.dateOfBirth,
    profileVisibility: ridersTable.profileVisibility,
  })
    .from(riderTranspondersTable)
    .innerJoin(ridersTable, eq(ridersTable.id, riderTranspondersTable.riderId))
    .where(eq(riderTranspondersTable.transponderNumber, number))
    .limit(1);
  if (!row) return null;
  return {
    riderId: row.riderId,
    kind: row.kind === "rfid" ? "rfid" : "trackr",
    firstName: row.firstName,
    lastName: row.lastName,
    isPublic: effectiveVisibility(row, todayYmd()) === "public",
  };
}

export type AddTransponderResult =
  | { ok: true; created: boolean; transponders: RiderTransponderView[] }
  | { ok: false; status: 409; error: string; ownerRiderId: number };

/**
 * Give a rider a transponder. Adding one they already have only updates its
 * label. A number on another rider's profile is refused with a message that
 * says whose it is (as much as `viewer` may see; see transponderTakenMessage).
 */
export async function addRiderTransponder(
  riderId: number,
  input: { number: string; kind: TransponderKind; label: string | null },
  viewer: "organizer" | "manager" | "rider",
  canSeeOwner?: (ownerRiderId: number) => Promise<boolean>,
): Promise<AddTransponderResult> {
  const number = normalizeTransponderNumber(input.number)!;
  const owner = await ownerOf(number);
  if (owner && owner.riderId !== riderId) {
    const level = viewer === "rider" && canSeeOwner && await canSeeOwner(owner.riderId) ? "manager" : viewer;
    return { ok: false, status: 409, error: transponderTakenMessage(number, input.kind, owner, level), ownerRiderId: owner.riderId };
  }
  let created = false;
  if (owner) {
    if (input.label !== null) {
      await db.update(riderTranspondersTable).set({ label: input.label, updatedAt: new Date() })
        .where(and(eq(riderTranspondersTable.riderId, riderId), eq(riderTranspondersTable.transponderNumber, number)));
    }
  } else {
    const inserted = await db.insert(riderTranspondersTable)
      .values({ riderId, transponderNumber: number, kind: input.kind, label: input.label })
      .onConflictDoNothing()
      .returning({ id: riderTranspondersTable.id });
    if (inserted.length === 0) {
      // Taken between the check and the insert.
      const now = await ownerOf(number);
      if (now && now.riderId !== riderId) {
        return { ok: false, status: 409, error: transponderTakenMessage(number, input.kind, now, viewer), ownerRiderId: now.riderId };
      }
    }
    created = inserted.length > 0;
  }
  return { ok: true, created, transponders: await listRiderTransponders(riderId) };
}

/**
 * Add a number the rider used somewhere (registration, check-in) to their list
 * when nobody owns it yet. Never takes a number from another rider and never
 * fails: the event-level assignment already times them at that event.
 */
export async function addRiderTransponderIfFree(riderId: number, rawNumber: string, kind: TransponderKind): Promise<boolean> {
  const number = normalizeTransponderNumber(rawNumber);
  if (!number) return false;
  const inserted = await db.insert(riderTranspondersTable)
    .values({ riderId, transponderNumber: number, kind })
    .onConflictDoNothing()
    .returning({ id: riderTranspondersTable.id });
  return inserted.length > 0;
}

/** True when another rider owns this number (list or profile field). */
export async function transponderOnAnotherRider(rawNumber: string, riderId: number): Promise<boolean> {
  const owner = await riderIdForTransponder(rawNumber);
  return owner != null && owner !== riderId;
}

/** Remove one of a rider's transponders by its id. Returns the remaining list, or null when it isn't theirs. */
export async function removeRiderTransponder(riderId: number, transponderId: number): Promise<RiderTransponderView[] | null> {
  const removed = await db.delete(riderTranspondersTable)
    .where(and(eq(riderTranspondersTable.id, transponderId), eq(riderTranspondersTable.riderId, riderId)))
    .returning({ id: riderTranspondersTable.id });
  if (removed.length === 0) return null;
  return listRiderTransponders(riderId);
}

export interface SyncedTransponder { number?: unknown; transponderNumber?: unknown; kind?: unknown; label?: unknown }

/**
 * Make a rider's list match one sent by the desktop (its offline edits): numbers
 * not sent are removed, new ones added. A number another rider owns is left
 * with them and reported back. Runs inside the caller's transaction.
 */
export async function replaceRiderTransponders(
  exec: typeof db,
  riderId: number,
  sent: SyncedTransponder[],
): Promise<Array<{ number: string; ownerRiderId: number }>> {
  const wanted = new Map<string, { kind: TransponderKind; label: string | null }>();
  for (const t of sent) {
    const number = normalizeTransponderNumber(String(t?.number ?? t?.transponderNumber ?? ""));
    if (!number) continue;
    wanted.set(number, {
      kind: t?.kind === "rfid" ? "rfid" : "trackr",
      label: typeof t?.label === "string" ? t.label.trim().slice(0, 60) || null : null,
    });
  }
  const current = await exec.select().from(riderTranspondersTable).where(eq(riderTranspondersTable.riderId, riderId));
  for (const row of current) {
    if (!wanted.has(row.transponderNumber)) {
      await exec.delete(riderTranspondersTable).where(eq(riderTranspondersTable.id, row.id));
    } else {
      const w = wanted.get(row.transponderNumber)!;
      if (w.label !== row.label) {
        await exec.update(riderTranspondersTable).set({ label: w.label, updatedAt: new Date() }).where(eq(riderTranspondersTable.id, row.id));
      }
    }
  }
  const have = new Set(current.map((r) => r.transponderNumber));
  const conflicts: Array<{ number: string; ownerRiderId: number }> = [];
  for (const [number, w] of wanted) {
    if (have.has(number)) continue;
    const inserted = await exec.insert(riderTranspondersTable)
      .values({ riderId, transponderNumber: number, kind: w.kind, label: w.label })
      .onConflictDoNothing()
      .returning({ id: riderTranspondersTable.id });
    if (inserted.length === 0) {
      const [owner] = await exec.select({ riderId: riderTranspondersTable.riderId }).from(riderTranspondersTable)
        .where(eq(riderTranspondersTable.transponderNumber, number));
      if (owner && owner.riderId !== riderId) conflicts.push({ number, ownerRiderId: owner.riderId });
    }
  }
  return conflicts;
}
