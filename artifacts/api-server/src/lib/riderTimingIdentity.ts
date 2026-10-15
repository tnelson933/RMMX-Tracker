export interface TimingIdentity {
  riderId: number;
  riderName: string;
  bibNumber: string | null;
}

export interface TimingAssignmentIdentityRow {
  eventId: number;
  assignmentId: number;
  riderId: number;
  firstName: string;
  lastName: string;
  bibNumber: string | null;
  timingIdentifier: string;
}

export interface TimingRegistrationIdentityRow {
  eventId: number;
  registrationId: number;
  riderId: number;
  firstName: string;
  lastName: string;
  registrationBibNumber: string | null;
  riderBibNumber: string | null;
  registrationTransponderNumber: string | null;
  profileRfidNumber: string | null;
  profileActiveTransponderNumber: string | null;
}

export interface TimingRiderIdentityRow {
  riderId: number;
  firstName: string;
  lastName: string;
  bibNumber: string | null;
  profileRfidNumber: string | null;
  profileActiveTransponderNumber: string | null;
}

export type TimingIdentityResolver = (
  eventId: number,
  timingIdentifier: string | null | undefined,
) => TimingIdentity | null;

export function normalizeTimingIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function toIdentity(row: {
  riderId: number;
  firstName: string;
  lastName: string;
  registrationBibNumber?: string | null;
  riderBibNumber?: string | null;
  bibNumber?: string | null;
}): TimingIdentity {
  return {
    riderId: row.riderId,
    riderName: `${row.firstName} ${row.lastName}`.trim(),
    bibNumber: row.registrationBibNumber ?? row.riderBibNumber ?? row.bibNumber ?? null,
  };
}

function setFirst(
  map: Map<string, TimingIdentity>,
  timingIdentifier: string | null,
  identity: TimingIdentity,
): void {
  const normalized = normalizeTimingIdentifier(timingIdentifier);
  if (normalized && !map.has(normalized)) map.set(normalized, identity);
}

export function buildTimingIdentityResolver(
  assignmentRows: TimingAssignmentIdentityRow[],
  registrationRows: TimingRegistrationIdentityRow[],
  riderRows: TimingRiderIdentityRow[],
): TimingIdentityResolver {
  const eventAssignmentMaps = new Map<number, Map<string, TimingIdentity>>();
  const eventRegistrationMaps = new Map<number, Map<string, TimingIdentity>>();
  const globalProfileMap = new Map<string, TimingIdentity>();
  const sortedAssignments = [...assignmentRows].sort(
    (a, b) => a.assignmentId - b.assignmentId || a.riderId - b.riderId,
  );
  const sortedRegistrations = [...registrationRows].sort(
    (a, b) => a.registrationId - b.registrationId || a.riderId - b.riderId,
  );

  // Match processCrossing precedence: an event/club RFID assignment wins over
  // an active registration value, which wins over global profile identifiers.
  for (const row of sortedAssignments) {
    if (!eventAssignmentMaps.has(row.eventId)) eventAssignmentMaps.set(row.eventId, new Map());
    setFirst(
      eventAssignmentMaps.get(row.eventId)!,
      row.timingIdentifier,
      toIdentity(row),
    );
  }

  for (const row of sortedRegistrations) {
    if (!eventRegistrationMaps.has(row.eventId)) {
      eventRegistrationMaps.set(row.eventId, new Map());
    }
    setFirst(
      eventRegistrationMaps.get(row.eventId)!,
      row.registrationTransponderNumber,
      toIdentity(row),
    );
  }

  for (const row of [...riderRows].sort((a, b) => a.riderId - b.riderId)) {
    const identity = toIdentity(row);
    setFirst(globalProfileMap, row.profileRfidNumber, identity);
    setFirst(globalProfileMap, row.profileActiveTransponderNumber, identity);
  }

  return (eventId, timingIdentifier) => {
    const normalized = normalizeTimingIdentifier(timingIdentifier);
    if (!normalized) return null;
    return eventAssignmentMaps.get(eventId)?.get(normalized)
      ?? eventRegistrationMaps.get(eventId)?.get(normalized)
      ?? globalProfileMap.get(normalized)
      ?? null;
  };
}

export function resolveCrossingRiderId(
  storedRiderId: number | null,
  eventId: number,
  timingIdentifier: string,
  resolveTimingIdentity: TimingIdentityResolver,
): number | null {
  // A persisted rider link is authoritative. Identifier fallback is only for
  // legacy/unlinked crossings so a duplicate tag cannot expose another rider.
  if (storedRiderId !== null) return storedRiderId;
  return resolveTimingIdentity(eventId, timingIdentifier)?.riderId ?? null;
}

export function crossingBelongsToRider(
  storedRiderId: number | null,
  eventId: number,
  timingIdentifier: string,
  riderId: number,
  resolveTimingIdentity: TimingIdentityResolver,
): boolean {
  return resolveCrossingRiderId(
    storedRiderId,
    eventId,
    timingIdentifier,
    resolveTimingIdentity,
  ) === riderId;
}