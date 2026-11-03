/** Group race event settings (no database access, so input validation can use it). */

export const MIN_RIDERS_PER_GROUP = 2;
export const MAX_RIDERS_PER_GROUP = 20;

/** Riders per group as a whole number from 2 to 20, or null when it isn't one. */
export function normalizeRidersPerGroup(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_RIDERS_PER_GROUP || n > MAX_RIDERS_PER_GROUP) return null;
  return n;
}

/** Event create/update: a group race needs a team size. */
export function groupRaceSettingsError(body: Record<string, unknown>): string | null {
  if (body.ridersPerGroup !== undefined && body.ridersPerGroup !== null && body.ridersPerGroup !== ""
      && normalizeRidersPerGroup(body.ridersPerGroup) === null) {
    return `Riders per group must be a whole number from ${MIN_RIDERS_PER_GROUP} to ${MAX_RIDERS_PER_GROUP}.`;
  }
  if (body.groupRace === true && normalizeRidersPerGroup(body.ridersPerGroup) === null) {
    return `Group races need the number of riders per group (${MIN_RIDERS_PER_GROUP} to ${MAX_RIDERS_PER_GROUP}).`;
  }
  return null;
}
