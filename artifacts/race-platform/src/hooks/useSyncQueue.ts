import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { offlineDb } from "@/lib/offlineDb";
import { useOfflineStatus } from "@/hooks/useOfflineStatus";
import {
  getListCheckinsQueryKey,
  getGetRaceDaySummaryQueryKey,
  getListRegistrationsQueryKey,
} from "@workspace/api-client-react";

export function useSyncQueue(eventId: number) {
  const queryClient = useQueryClient();
  const { isOnline } = useOfflineStatus();
  const [pendingRiderIds, setPendingRiderIds] = useState<Set<number>>(new Set());
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncInProgressRef = useRef(false);

  const refreshPending = useCallback(async () => {
    const mutations = await offlineDb.pendingMutations
      .where("eventId")
      .equals(eventId)
      .toArray();
    setPendingRiderIds(new Set(mutations.map((m) => m.riderId)));
  }, [eventId]);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const sync = useCallback(async () => {
    if (syncInProgressRef.current) return;

    const mutations = await offlineDb.pendingMutations
      .where("eventId")
      .equals(eventId)
      .sortBy("createdAt");

    if (mutations.length === 0) return;

    syncInProgressRef.current = true;
    setIsSyncing(true);
    setSyncError(null);

    let anySucceeded = false;
    const errors: string[] = [];

    for (const mutation of mutations) {
      try {
        const body: Record<string, unknown> = { riderId: mutation.riderId };
        if (mutation.rfidNumber != null) body.rfidNumber = mutation.rfidNumber;
        if (mutation.bibNumber != null) body.bibNumber = mutation.bibNumber;

        const res = await fetch(`/api/events/${mutation.eventId}/checkins`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body),
        });

        if (res.ok || res.status === 409) {
          await offlineDb.pendingMutations.delete(mutation.id!);
          anySucceeded = true;
        } else {
          await offlineDb.pendingMutations.update(mutation.id!, {
            attempts: mutation.attempts + 1,
            lastError: `HTTP ${res.status}`,
          });
          errors.push(`HTTP ${res.status}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        await offlineDb.pendingMutations.update(mutation.id!, {
          attempts: mutation.attempts + 1,
          lastError: msg,
        });
        errors.push(msg);
      }
    }

    if (anySucceeded) {
      queryClient.invalidateQueries({ queryKey: getListCheckinsQueryKey(eventId) });
      queryClient.invalidateQueries({ queryKey: getGetRaceDaySummaryQueryKey(eventId) });
      queryClient.invalidateQueries({ queryKey: getListRegistrationsQueryKey(eventId) });
    }

    if (errors.length > 0) {
      setSyncError(`${errors.length} check-in(s) failed to sync — will retry when online.`);
    }

    await refreshPending();
    syncInProgressRef.current = false;
    setIsSyncing(false);
  }, [eventId, queryClient, refreshPending]);

  useEffect(() => {
    if (isOnline && pendingRiderIds.size > 0) {
      sync();
    }
  }, [isOnline, pendingRiderIds.size, sync]);

  const queueCheckin = useCallback(
    async (
      riderId: number,
      rfidNumber: string | null,
      bibNumber: string | null
    ) => {
      await offlineDb.pendingMutations.add({
        type: "checkin",
        eventId,
        riderId,
        rfidNumber,
        bibNumber,
        createdAt: Date.now(),
        attempts: 0,
        lastError: null,
      });
      await refreshPending();
    },
    [eventId, refreshPending]
  );

  return {
    pendingRiderIds,
    pendingCount: pendingRiderIds.size,
    isSyncing,
    syncError,
    queueCheckin,
    sync,
  };
}
