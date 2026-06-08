import { useState, useEffect, useRef } from "react";
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
  const lastWrittenRef = useRef<string | null>(null);

  useEffect(() => {
    if (queryData !== undefined) {
      const serialized = JSON.stringify(queryData);
      if (lastWrittenRef.current !== serialized) {
        lastWrittenRef.current = serialized;
        cacheWrite(cacheKey, queryData);
      }
    }
  }, [cacheKey, queryData]);

  useEffect(() => {
    const shouldReadCache =
      queryData === undefined && (isOffline || queryIsError);
    if (!shouldReadCache) return;

    setLoadingCache(true);
    cacheRead<T>(cacheKey).then((result) => {
      if (result) {
        setCachedData(result.data);
        setCachedAt(result.cachedAt);
      }
      setLoadingCache(false);
    });
  }, [cacheKey, queryData, isOffline, queryIsError]);

  const isFromCache = queryData === undefined && cachedData !== undefined;

  return {
    data: queryData ?? cachedData,
    isLoading: queryIsLoading || loadingCache,
    isFromCache,
    cachedAt: isFromCache ? cachedAt : null,
  };
}
