import { isValidActiveTransponderIdentifier } from "@workspace/api-zod";

/**
 * Which kinds of tag an event's readers use (api-server lib/eventTimingTags).
 * Events don't pick a timing technology: RM TrackR loops and RFID readers can
 * time the same event. `fromReaders` is false when no readers are set up yet,
 * so either kind may be used.
 */
export interface TimingTags {
  transponder: boolean;
  rfid: boolean;
  fromReaders: boolean;
}

export const ANY_TIMING_TAGS: TimingTags = { transponder: true, rfid: true, fromReaders: false };

/**
 * An event's tags from the API. The desktop app's offline server doesn't send
 * them (its readers are set up on the laptop), so there either kind may be used.
 */
export function eventTimingTags(event: unknown): TimingTags {
  const e = (event ?? {}) as { timingTags?: TimingTags | null };
  return e.timingTags && typeof e.timingTags === "object" ? e.timingTags : ANY_TIMING_TAGS;
}

/** "RM TrackR", "RFID" or "RM TrackR + RFID". */
export function timingTagsLabel(tags: TimingTags): string {
  if (tags.transponder && tags.rfid) return "RM TrackR + RFID";
  return tags.transponder ? "RM TrackR" : "RFID";
}

/**
 * A registration's transponder field, split by what it really holds. Before an
 * event could use both kinds of reader, assigning an RFID sticker also copied
 * its number there, so a value that isn't a valid RM TrackR ID (1–9 hex
 * characters) is an RFID sticker, not a bad transponder number.
 */
export function splitRegistrationTag(value: string | null | undefined): { transponder: string | null; sticker: string | null } {
  const v = value?.trim() || null;
  if (!v) return { transponder: null, sticker: null };
  return isValidActiveTransponderIdentifier(v) ? { transponder: v, sticker: null } : { transponder: null, sticker: v };
}
