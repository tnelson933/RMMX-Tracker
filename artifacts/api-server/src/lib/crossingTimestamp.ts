import { logger } from "./logger";

export const MAX_CROSSING_FUTURE_MS = 5 * 60 * 1000;

export function canonicalizeCrossingTimestamp(
  value: unknown,
  receivedAt = new Date(),
  context: Record<string, unknown> = {},
): Date {
  const candidate = value instanceof Date ? value : new Date(value as string | number);
  const candidateMs = candidate.getTime();
  const receivedMs = receivedAt.getTime();
  const reason = !Number.isFinite(candidateMs)
    ? "invalid"
    : candidateMs > receivedMs + MAX_CROSSING_FUTURE_MS
      ? "implausibly_future"
      : null;

  if (reason) {
    logger.warn({
      event: "crossing_timestamp_canonicalized",
      reason,
      suppliedTimestamp: Number.isFinite(candidateMs) ? candidate.toISOString() : String(value),
      receivedAt: receivedAt.toISOString(),
      futureOffsetMs: Number.isFinite(candidateMs) ? candidateMs - receivedMs : null,
      ...context,
    }, "crossing timestamp replaced with server receive time");
    return receivedAt;
  }
  return candidate;
}

export function isImplausiblyFutureCrossing(crossingTime: Date, receivedAt: Date): boolean {
  return crossingTime.getTime() > receivedAt.getTime() + MAX_CROSSING_FUTURE_MS;
}

export function deriveClockSkewRepair(
  startedAt: Date,
  crossings: Array<{ id: number; crossingTime: Date; createdAt: Date }>,
): Array<{ id: number; crossingTime: Date; lapTimeMs: number }> | null {
  if (!crossings.some(c => isImplausiblyFutureCrossing(c.crossingTime, c.createdAt))) return null;
  let previousMs = startedAt.getTime();
  const repaired: Array<{ id: number; crossingTime: Date; lapTimeMs: number }> = [];
  for (const crossing of crossings) {
    const effective = isImplausiblyFutureCrossing(crossing.crossingTime, crossing.createdAt)
      ? crossing.createdAt
      : crossing.crossingTime;
    const lapTimeMs = effective.getTime() - previousMs;
    if (!Number.isFinite(lapTimeMs) || lapTimeMs < 0) return null;
    repaired.push({ id: crossing.id, crossingTime: effective, lapTimeMs });
    previousMs = effective.getTime();
  }
  return repaired;
}