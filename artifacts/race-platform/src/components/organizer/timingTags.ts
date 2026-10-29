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
