/**
 * The Following feed lists one card per rider, event and class. The server
 * groups by rider id, but the same person can appear twice (a duplicate rider
 * profile, a followed rider who is also on your account, or the class typed
 * "250 B" one time and "250 b " the next), so the cards are de-duplicated by
 * what the card shows: rider name, event and class. The first one (newest) wins.
 */
const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function dedupeFeedItems<T extends { riderName: string; eventId: number; raceClass: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.eventId}|${norm(item.raceClass)}|${norm(item.riderName)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
