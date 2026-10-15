const ACTIVE_TRANSPONDER_ID_PATTERN = /^[0-9a-f]{1,9}$/;

/**
 * Active transponder identifiers are one to nine hexadecimal characters.
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