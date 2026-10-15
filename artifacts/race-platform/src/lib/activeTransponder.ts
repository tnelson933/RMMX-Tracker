import { isValidActiveTransponderIdentifier } from "@workspace/api-zod";

/**
 * Empty values represent an unassigned active transponder and are not a format
 * error. Any nonempty value must satisfy the canonical active identifier rule.
 */
export function isInvalidAssignedActiveTransponderIdentifier(
  value: string | null | undefined,
): boolean {
  return Boolean(value?.trim()) && !isValidActiveTransponderIdentifier(value);
}