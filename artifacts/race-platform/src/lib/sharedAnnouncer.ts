export type SharedAnnouncement = {
  sequence: number;
  audioUrl: string;
  label: string;
  createdAt: string;
};

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

export function announcementStartOffsetSeconds(announcement: SharedAnnouncement): number {
  const ageMs = Date.now() - new Date(announcement.createdAt).getTime();
  return Math.max(0, ageMs / 1_000);
}

export function appendAnnouncementTask(
  previous: Promise<void>,
  task: () => Promise<void>,
): Promise<void> {
  return previous.catch(() => {}).then(task);
}