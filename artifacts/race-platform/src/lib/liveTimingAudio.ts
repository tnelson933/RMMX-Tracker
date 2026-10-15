const FAST_ACK_SNAPSHOT_WINDOW_MS = 5_000;
const pendingManualPingsByMoto = new Map<number, number[]>();

export function registerAcceptedCrossing(seenCrossingIds: Set<number>, crossingId: number): boolean {
  if (seenCrossingIds.has(crossingId)) return false;
  seenCrossingIds.add(crossingId);
  return true;
}

export function shouldPlayAcceptedCrossing(readerId: string | null): boolean {
  return readerId !== "MANUAL";
}

export function markManualOptimisticPing(motoId: number, now = Date.now()): void {
  const pending = pendingManualPingsByMoto.get(motoId) ?? [];
  pending.push(now);
  pendingManualPingsByMoto.set(motoId, pending);
}

export function consumeManualOptimisticPings(
  motoId: number,
  maximum: number,
  now = Date.now(),
): number {
  const recent = (pendingManualPingsByMoto.get(motoId) ?? [])
    .filter(time => now - time <= FAST_ACK_SNAPSHOT_WINDOW_MS);
  const consumed = Math.min(Math.max(0, maximum), recent.length);
  const remaining = recent.slice(consumed);
  if (remaining.length > 0) pendingManualPingsByMoto.set(motoId, remaining);
  else pendingManualPingsByMoto.delete(motoId);
  return consumed;
}

export function discardManualOptimisticPing(motoId: number): void {
  consumeManualOptimisticPings(motoId, 1);
}

export function consumeSnapshotFallback(
  lapDelta: number,
  pendingFastAckTimes: number[],
  now: number,
): { fallbackCount: number; pendingFastAckTimes: number[] } {
  const recent = pendingFastAckTimes.filter(time => now - time <= FAST_ACK_SNAPSHOT_WINDOW_MS);
  const acknowledged = Math.min(Math.max(0, lapDelta), recent.length);
  return {
    fallbackCount: Math.max(0, lapDelta - acknowledged),
    pendingFastAckTimes: recent.slice(acknowledged),
  };
}