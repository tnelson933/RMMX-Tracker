import { logger } from "./logger";

export const MAX_CROSSING_FUTURE_MS = 5 * 60 * 1000;

// These are the only provenance values emitted by our direct active timing
// bridges. Keep this intentionally narrow: a facility endpoint also accepts
// passive/generic hardware payloads, whose delayed readings are legitimate.
export const TRUSTED_DIRECT_ACTIVE_TIMING_SOURCES = [
  "connector_live_tcp",
  "f2000_tcp",
  "f2000_device",
  "bridge_live_tcp",
] as const;

export function isTrustedDirectActiveTimingSource(...values: unknown[]): boolean {
  const trusted = new Set<string>(TRUSTED_DIRECT_ACTIVE_TIMING_SOURCES);
  return values.some(value =>
    typeof value === "string" && trusted.has(value.trim().toLowerCase()),
  );
}

export function canonicalizeCrossingTimestamp(
  value: unknown,
  receivedAt = new Date(),
  context: Record<string, unknown> = {},
  rejectPastSkew = false,
): Date {
  const candidate = value instanceof Date ? value : new Date(value as string | number);
  const candidateMs = candidate.getTime();
  const receivedMs = receivedAt.getTime();
  const reason = !Number.isFinite(candidateMs)
    ? "invalid"
    : candidateMs > receivedMs + MAX_CROSSING_FUTURE_MS
      ? "implausibly_future"
      : rejectPastSkew && candidateMs < receivedMs - MAX_CROSSING_FUTURE_MS
        ? "implausibly_past"
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

export function parseTrustworthyReceivedAt(value: unknown, serverReceivedAt = new Date()): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const supplied = value instanceof Date ? value : new Date(value as string | number);
  return Number.isFinite(supplied.getTime())
    && supplied.getTime() <= serverReceivedAt.getTime() + MAX_CROSSING_FUTURE_MS
    ? supplied
    : null;
}

export function isImplausiblyFutureCrossing(crossingTime: Date, receivedAt: Date): boolean {
  return crossingTime.getTime() > receivedAt.getTime() + MAX_CROSSING_FUTURE_MS;
}

export function deriveClockSkewRepair(
  startedAt: Date,
  crossings: Array<{ id: number; crossingTime: Date; createdAt: Date }>,
): Array<{ id: number; crossingTime: Date; lapTimeMs: number }> | null {
  // Historical rows do not retain a durable original receipt or source, so a
  // past offset is indistinguishable from a legitimate delayed/retried upload.
  // Only repair the known reader-clock-ahead failure mode. New direct active
  // ingress handles trusted receipt-backed skew in both directions instead.
  if (crossings.length < 2) return null;
  const offsets = crossings.map(c => c.crossingTime.getTime() - c.createdAt.getTime());
  if (offsets.some(offset => !Number.isFinite(offset))) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const spread = sorted[sorted.length - 1] - sorted[0];
  const quarterHourMs = 15 * 60 * 1000;
  const timezoneDistance = Math.abs(Math.abs(median) - Math.round(Math.abs(median) / quarterHourMs) * quarterHourMs);
  const sameSign = offsets.every(offset => Math.sign(offset) === Math.sign(median));
  if (
    median <= MAX_CROSSING_FUTURE_MS
    || spread > 2 * 60 * 1000
    || !sameSign
    || timezoneDistance > 2 * 60 * 1000
  ) return null;

  let previousMs = startedAt.getTime();
  const repaired: Array<{ id: number; crossingTime: Date; lapTimeMs: number }> = [];
  for (const crossing of crossings) {
    const effective = crossing.createdAt;
    const lapTimeMs = effective.getTime() - previousMs;
    if (!Number.isFinite(lapTimeMs) || lapTimeMs < 0) return null;
    repaired.push({ id: crossing.id, crossingTime: effective, lapTimeMs });
    previousMs = effective.getTime();
  }
  return repaired;
}