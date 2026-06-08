import Dexie, { type Table } from "dexie";

interface CachedApiEntry {
  key: string;
  data: unknown;
  cachedAt: number;
}

class OfflineDatabase extends Dexie {
  apiCache!: Table<CachedApiEntry>;

  constructor() {
    super("RMRacePlatformOfflineDB");
    this.version(1).stores({
      apiCache: "key, cachedAt",
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
