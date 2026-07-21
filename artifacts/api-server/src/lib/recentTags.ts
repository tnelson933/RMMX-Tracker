/**
 * In-memory "recently seen tags" buffer, per club.
 *
 * Every tag read that arrives at the ingest endpoints is recorded here
 * (regardless of whether it matched a rider or an active moto/practice), so
 * organizers can hold a tag near the antenna and read its EPC off the Reader
 * Setup page to assign it to a rider.
 */

interface SeenTag {
  rfidNumber: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

const MAX_TAGS_PER_CLUB = 50;
const EXPIRE_MS = 10 * 60 * 1000; // drop tags not seen for 10 minutes

const byClub = new Map<number, Map<string, SeenTag>>();

// Periodic sweep so inactive clubs don't accumulate stale maps forever
setInterval(() => {
  const cutoff = Date.now() - EXPIRE_MS;
  for (const [clubId, tags] of byClub) {
    for (const [k, v] of tags) {
      if (v.lastSeenAt < cutoff) tags.delete(k);
    }
    if (tags.size === 0) byClub.delete(clubId);
  }
}, EXPIRE_MS).unref();

export function recordTagSeen(clubId: number, rawRfidNumber: string): void {
  if (!clubId || !rawRfidNumber) return;
  const rfidNumber = rawRfidNumber.toUpperCase();
  let tags = byClub.get(clubId);
  if (!tags) {
    tags = new Map();
    byClub.set(clubId, tags);
  }
  const now = Date.now();
  const existing = tags.get(rfidNumber);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
  } else {
    // Evict the stalest entry if at capacity
    if (tags.size >= MAX_TAGS_PER_CLUB) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of tags) {
        if (v.lastSeenAt < oldestAt) {
          oldestAt = v.lastSeenAt;
          oldestKey = k;
        }
      }
      if (oldestKey) tags.delete(oldestKey);
    }
    tags.set(rfidNumber, { rfidNumber, count: 1, firstSeenAt: now, lastSeenAt: now });
  }
}

export function getRecentTags(clubId: number): SeenTag[] {
  const tags = byClub.get(clubId);
  if (!tags) return [];
  const cutoff = Date.now() - EXPIRE_MS;
  const out: SeenTag[] = [];
  for (const [k, v] of tags) {
    if (v.lastSeenAt < cutoff) {
      tags.delete(k);
    } else {
      out.push(v);
    }
  }
  // Most recently seen first
  return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function clearRecentTags(clubId: number): void {
  byClub.delete(clubId);
}
