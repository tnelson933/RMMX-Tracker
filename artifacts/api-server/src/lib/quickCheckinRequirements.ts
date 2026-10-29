import { hasRequiredTags, type TimingTags } from "./eventTimingTags";

/**
 * What a rider needs before they can Quick Check-In from the rider app. Each
 * event can turn requirements off (Edit event → Quick Check-In → Requirements);
 * a missing or partial setting means the requirement is on.
 */
export interface QuickCheckinRequirements {
  /** Registration is paid (online checkout completed). */
  paid: boolean;
  /** An RFID tag or transponder number is on file for the event. */
  timing: boolean;
  /** Any waiver the event requires is signed. */
  waiver: boolean;
  /** Nothing to pick up at the gate: a rental, an RM TrackR or an RFID sticker they bought. */
  pickup: boolean;
  /** The rider's phone is within the check-in radius of the track. */
  atTrack: boolean;
}

export const QUICK_CHECKIN_REQUIREMENT_KEYS = ["paid", "timing", "waiver", "pickup", "atTrack"] as const;

export const DEFAULT_QUICK_CHECKIN_REQUIREMENTS: QuickCheckinRequirements = {
  paid: true, timing: true, waiver: true, pickup: true, atTrack: true,
};

/** The event's stored setting with every unset requirement on. */
export function quickCheckinRequirements(stored: unknown): QuickCheckinRequirements {
  const out = { ...DEFAULT_QUICK_CHECKIN_REQUIREMENTS };
  if (stored && typeof stored === "object") {
    for (const key of QUICK_CHECKIN_REQUIREMENT_KEYS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "boolean") out[key] = v;
    }
  }
  return out;
}

/** Validate a setting sent by the organizer; returns an error message or the value to store. */
export function parseQuickCheckinRequirements(input: unknown): { value: QuickCheckinRequirements | null } | { error: string } {
  if (input === null) return { value: null };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "quickCheckinRequirements must be an object" };
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(QUICK_CHECKIN_REQUIREMENT_KEYS as readonly string[]).includes(key)) return { error: `Unknown Quick Check-In requirement: ${key}` };
    if (typeof v !== "boolean") return { error: `Quick Check-In requirement ${key} must be true or false` };
  }
  return { value: quickCheckinRequirements(input) };
}

export interface QuickCheckinRiderState {
  registrationConfirmed: boolean;
  /** Tag kinds the event's readers use (lib/eventTimingTags). */
  tags: TimingTags;
  hasRfid: boolean;
  hasTransponder: boolean;
  waiverRequired: boolean;
  waiverSigned: boolean;
  needsPickup: boolean;
}

export type QuickCheckinIneligibleReason =
  | "payment_required" | "missing_rfid" | "missing_transponder" | "missing_waiver" | "pickup_required";

/** The first requirement the rider doesn't meet, or null when they can check in. */
export function quickCheckinIneligibleReason(
  req: QuickCheckinRequirements,
  s: QuickCheckinRiderState,
): QuickCheckinIneligibleReason | null {
  if (req.paid && !s.registrationConfirmed) return "payment_required";
  if (req.timing && !hasRequiredTags(s.tags, { transponder: s.hasTransponder, rfid: s.hasRfid })) {
    // Name the kind that's missing (a transponder when either would do).
    if (!s.tags.fromReaders || (s.tags.transponder && !s.hasTransponder)) return "missing_transponder";
    return "missing_rfid";
  }
  if (req.waiver && s.waiverRequired && !s.waiverSigned) return "missing_waiver";
  if (req.pickup && s.needsPickup) return "pickup_required";
  return null;
}

/**
 * Does any of a rider's sticker rows count as an RFID sticker? Older
 * registrations also stored the transponder number as a sticker row.
 */
export function hasStickerBesidesTransponder(stickers: string[] | undefined, transponder: string | null | undefined): boolean {
  const t = transponder?.trim().toLowerCase() ?? "";
  return (stickers ?? []).some(n => n.trim().toLowerCase() !== t);
}

export const QUICK_CHECKIN_REASON_TEXT: Record<QuickCheckinIneligibleReason, string> = {
  payment_required: "No paid registration found for this event. Finish payment or check in at the gate.",
  missing_rfid: "RFID not assigned — contact the organizer",
  missing_transponder: "Active transponder number not assigned — contact the organizer",
  missing_waiver: "Waiver not signed — please complete the waiver before checking in",
  pickup_required: "You have a transponder or RFID sticker to pick up — check in at the gate",
};
