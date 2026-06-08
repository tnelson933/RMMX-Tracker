import { useState, useEffect } from "react";
import { cacheWrite, cacheRead } from "@/lib/offlineDb";
import { useOfflineStatus } from "@/hooks/useOfflineStatus";

interface OfflineAwareResult<T> {
  data: T | undefined;
  isLoading: boolean;
  isFromCache: boolean;
  cachedAt: number | null;
}

export function useOfflineAwareQuery<T>(
  cacheKey: string,
  queryData: T | undefined,
  queryIsLoading: boolean,
  queryIsError: boolean
): OfflineAwareResult<T> {
  const { isOffline } = useOfflineStatus();
  const [cachedData, setCachedData] = useState<T | undefined>(undefined);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [loadingCache, setLoadingCache] = useState(false);

  // Write fresh data to Dexie whenever the query succeeds.
  useEffect(() => {
    if (queryData !== undefined) {
      cacheWrite(cacheKey, queryData);
    }
  }, [cacheKey, queryData]);

  // Read from Dexie when we have no live data and are offline or errored.
  // Guard: skip if cachedData is already loaded to avoid repeated reads.
  useEffect(() => {
    const shouldReadCache =
      queryData === undefined &&
      cachedData === undefined &&
      (isOffline || queryIsError);

    if (!shouldReadCache) return;

    setLoadingCache(true);
    cacheRead<T>(cacheKey).then((result) => {
      if (result) {
        setCachedData(result.data);
        setCachedAt(result.cachedAt);
      }
      setLoadingCache(false);
    });
  }, [cacheKey, queryData, cachedData, isOffline, queryIsError]);

  // Reset cached data when live data arrives so stale cache doesn't persist.
  useEffect(() => {
    if (queryData !== undefined && cachedData !== undefined) {
      setCachedData(undefined);
      setCachedAt(null);
    }
  }, [queryData, cachedData]);

  const isFromCache = queryData === undefined && cachedData !== undefined;
  const hasData = queryData !== undefined || cachedData !== undefined;

  return {
    data: queryData ?? cachedData,
    // Only show loading if we have no data at all yet.
    isLoading: !hasData && (queryIsLoading || loadingCache),
    isFromCache,
    cachedAt: isFromCache ? cachedAt : null,
  };
}
