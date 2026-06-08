import Dexie, { type Table } from "dexie";

interface CachedApiEntry {
  key: string;
  data: unknown;
  cachedAt: number;
}

export interface PendingMutation {
  id?: number;
  type: "checkin";
  eventId: number;
  riderId: number;
  rfidNumber: string | null;
  bibNumber: string | null;
  createdAt: number;
  attempts: number;
  lastError: string | null;
}

class OfflineDatabase extends Dexie {
  apiCache!: Table<CachedApiEntry>;
  pendingMutations!: Table<PendingMutation>;

  constructor() {
    super("RMRacePlatformOfflineDB");
    this.version(1).stores({
      apiCache: "key, cachedAt",
    });
    this.version(2).stores({
      apiCache: "key, cachedAt",
      pendingMutations: "++id, type, eventId, createdAt",
    });
  }
}

export const offlineDb = new OfflineDatabase();

export async function cacheWrite(key: string, data: unknown): Promise<void> {
  await offlineDb.apiCache.put({ key, data, cachedAt: Date.now() });
}

export async function cacheRead<T>(
  key: string
): Promise<{ data: T; cachedAt: number } | null> {
  const entry = await offlineDb.apiCache.get(key);
  if (!entry) return null;
  return { data: entry.data as T, cachedAt: entry.cachedAt };
}
