export type SharedAnnouncement = {
  sequence: number;
  audioUrl: string;
  label: string;
  createdAt: string;
  /** When the race moment happened; older servers only send createdAt. */
  eventAt?: string;
  kind?: "start" | "lap" | "time_expired" | "extra_lap" | "finish";
};

/** How long after the moment a call is still worth playing (matches the server). */
export const ANNOUNCEMENT_MAX_AGE_MS: Record<NonNullable<SharedAnnouncement["kind"]>, number> = {
  start: 20_000,
  lap: 25_000,
  extra_lap: 25_000,
  time_expired: 20_000,
  finish: 120_000,
};

export function isAnnouncementStale(announcement: SharedAnnouncement, nowMs = Date.now()): boolean {
  const at = Date.parse(announcement.eventAt ?? announcement.createdAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at > ANNOUNCEMENT_MAX_AGE_MS[announcement.kind ?? "lap"];
}

export type QueuedAnnouncement = { url: string; announcement: SharedAnnouncement };

/**
 * A new call replaces calls still waiting to play (the race has moved on);
 * a finish call is never dropped. Returns the new queue and what was dropped.
 */
export function queueAnnouncement(
  queue: QueuedAnnouncement[],
  item: QueuedAnnouncement,
): { queue: QueuedAnnouncement[]; dropped: QueuedAnnouncement[] } {
  const keep = queue.filter(q => q.announcement.kind === "finish");
  const dropped = queue.filter(q => q.announcement.kind !== "finish");
  return { queue: [...keep, item], dropped };
}

export function shouldAcceptAnnouncement(
  lastSequence: number,
  announcement: SharedAnnouncement | null | undefined,
): boolean {
  return !!announcement && announcement.sequence > lastSequence;
}

export function shouldQueueAnnouncementAudio(announcerOn: boolean): boolean {
  return announcerOn;
}

export function isCurrentAnnouncementGeneration(current: number, candidate: number): boolean {
  return current === candidate;
}

export function sharedAnnouncerMotoId(
  moto: { id: number; status: string } | null | undefined,
): number | null {
  return moto && (moto.status === "in_progress" || moto.status === "completed")
    ? moto.id
    : null;
}

export function appendAnnouncementTask(
  previous: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return previous.catch(() => {}).then(task);
}