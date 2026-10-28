// Small input checks shared by routes. Each returns an error message for the
// first bad field, or null when the input is acceptable. Fields that are absent,
// null or "" are left to the route (they usually mean "not set").

const isBlank = (v: unknown) => v === undefined || v === null || v === "";

/** YYYY-MM-DD that is a real calendar date. */
export function isCalendarDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const day = value.substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(day);
}

export function isDateTime(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

export function isEmail(value: unknown): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function checkMoney(body: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const v = body[field];
    if (isBlank(v)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `${field} must be a dollar amount of 0 or more`;
    if (n > 100_000) return `${field} is too large`;
  }
  return null;
}

export function checkDates(body: Record<string, unknown>, dateFields: string[], dateTimeFields: string[] = []): string | null {
  for (const field of dateFields) {
    if (!isBlank(body[field]) && !isCalendarDate(body[field])) return `${field} must be a date like 2026-06-14`;
  }
  for (const field of dateTimeFields) {
    if (!isBlank(body[field]) && !isDateTime(body[field])) return `${field} must be a valid date and time`;
  }
  return null;
}

export function checkOneOf(body: Record<string, unknown>, field: string, allowed: readonly string[]): string | null {
  const v = body[field];
  if (v === undefined) return null;
  return allowed.includes(String(v)) ? null : `${field} must be one of: ${allowed.join(", ")}`;
}

export const EVENT_STATUSES = ["draft", "registration_open", "registration_closed", "race_day", "completed", "results_published"] as const;

/** Event create/update fields. */
export function validateEventInput(body: Record<string, unknown>): string | null {
  return (
    checkDates(body, ["date", "endDate"], ["registrationOpen", "registrationClose", "earlyBirdEndsAt"]) ??
    checkMoney(body, ["entryFee", "earlyBirdFee", "transponderRentalFee", "rfidStickerFee"]) ??
    checkOneOf(body, "status", EVENT_STATUSES) ??
    (!isBlank(body.maxRiders) && (!Number.isInteger(Number(body.maxRiders)) || Number(body.maxRiders) < 1)
      ? "maxRiders must be a whole number of 1 or more" : null)
  );
}

/** Birthdate as YYYY-MM-DD or MM/DD/YYYY, not in the future, after 1900. */
export function checkBirthDate(value: unknown): string | null {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const iso = us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : text;
  if (!isCalendarDate(iso)) return "Date of birth must be a date like 2008-05-21";
  const day = iso.substring(0, 10);
  if (day < "1900-01-01" || day > new Date().toISOString().substring(0, 10)) return "Date of birth isn't a valid birthdate";
  return null;
}
