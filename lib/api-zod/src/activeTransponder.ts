const ACTIVE_TRANSPONDER_ID_PATTERN = /^[0-9a-f]{1,9}$/;

/**
 * Active timing transponder identifiers support Feibot's hexadecimal IDs while
 * retaining the legacy MyLaps range of one to nine numeric characters.
 */
export function normalizeActiveTransponderIdentifier(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return ACTIVE_TRANSPONDER_ID_PATTERN.test(normalized) ? normalized : null;
}

export function isValidActiveTransponderIdentifier(
  value: string | null | undefined,
): boolean {
  return normalizeActiveTransponderIdentifier(value) !== null;
}