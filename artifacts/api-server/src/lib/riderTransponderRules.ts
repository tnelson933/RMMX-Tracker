import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";

/**
 * Rules for the transponders a rider owns (rider_transponders), with no
 * database access so they can be unit tested and shared by the cloud routes.
 * The offline server keeps a copy in artifacts/local-server/src/lib/rider-transponders.ts.
 */

export type TransponderKind = "trackr" | "rfid";

export const TRANSPONDER_KIND_NAMES: Record<TransponderKind, string> = {
  trackr: "RM TrackR",
  rfid: "RFID sticker",
};

/** How every transponder number is stored and compared: trimmed, lower-case. */
export function normalizeTransponderNumber(value: string | null | undefined): string | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v || null;
}

export function parseTransponderKind(value: unknown): TransponderKind | null {
  if (value == null || value === "") return "trackr";
  return value === "trackr" || value === "rfid" ? value : null;
}

export type TransponderInput =
  | { ok: true; number: string; kind: TransponderKind; label: string | null }
  | { ok: false; error: string };

/** Validate a number a person typed, for the kind they picked (RM TrackR by default). */
export function parseTransponderInput(body: { number?: unknown; transponderNumber?: unknown; kind?: unknown; label?: unknown }): TransponderInput {
  const kind = parseTransponderKind(body.kind);
  if (!kind) return { ok: false, error: "Choose RM TrackR or RFID sticker." };
  const raw = String(body.number ?? body.transponderNumber ?? "").trim();
  if (!raw) return { ok: false, error: `Enter the number printed on the ${TRANSPONDER_KIND_NAMES[kind]}.` };
  let number: string | null;
  if (kind === "trackr") {
    number = normalizeActiveTransponderIdentifier(raw);
    if (!number) return { ok: false, error: "Enter the ID printed on the RM TrackR (up to 9 numbers or letters A–F)." };
  } else {
    number = /^[A-Za-z0-9-]{1,64}$/.test(raw) ? raw.toLowerCase() : null;
    if (!number) return { ok: false, error: "Enter the number printed on the RFID sticker (letters and numbers only)." };
  }
  const labelText = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  return { ok: true, number, kind, label: labelText || null };
}

/**
 * What a rider (or their account) is told when they try to give themselves a
 * transponder that's on someone else's profile (owner's wording, 2026-11-20).
 * Riders never see whose it is.
 */
export const TRANSPONDER_TAKEN_FOR_RIDER =
  "This transponder is already assigned to another user. Please have that user delete this transponder from their account, then it can be assigned to you.";

export interface TransponderOwner {
  riderId: number;
  firstName: string;
  lastName: string;
  /** Whether the rider's profile is public (effectiveVisibility). */
  isPublic: boolean;
}

/**
 * Who a taken number belongs to, for the person trying to add it. Organizers
 * see the full name (they move numbers between riders); riders get
 * TRANSPONDER_TAKEN_FOR_RIDER and never see who has it.
 */
export function transponderTakenMessage(
  number: string,
  kind: TransponderKind,
  owner: TransponderOwner,
  viewer: "organizer" | "rider",
): string {
  const what = `${TRANSPONDER_KIND_NAMES[kind]} ${number.toUpperCase()}`;
  if (viewer === "organizer") {
    const name = `${owner.firstName} ${owner.lastName}`.trim() || `rider #${owner.riderId}`;
    return `${what} is already assigned to ${name} (rider #${owner.riderId}). Remove it from their profile first if it changed hands.`;
  }
  return TRANSPONDER_TAKEN_FOR_RIDER;
}

export interface RiderTransponderView {
  id: number;
  number: string;
  kind: TransponderKind;
  kindName: string;
  label: string | null;
  primary: boolean;
  createdAt: string | null;
}

/** API shape of a rider's list, oldest first; the oldest of each kind is its primary. */
export function toTransponderViews(rows: Array<{
  id: number; transponderNumber: string; kind: string; label: string | null; createdAt?: Date | string | null;
}>): RiderTransponderView[] {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const seen = new Set<string>();
  return sorted.map((r) => {
    const kind: TransponderKind = r.kind === "rfid" ? "rfid" : "trackr";
    const primary = !seen.has(kind);
    seen.add(kind);
    return {
      id: r.id,
      number: r.transponderNumber.toUpperCase(),
      kind,
      kindName: TRANSPONDER_KIND_NAMES[kind],
      label: r.label ?? null,
      primary,
      createdAt: r.createdAt == null ? null : new Date(r.createdAt).toISOString(),
    };
  });
}
