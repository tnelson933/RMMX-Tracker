// Small input checks shared by routes. Each returns an error message for the
// first bad field, or null when the input is acceptable. Fields that are absent,
// null or "" are left to the route (they usually mean "not set").

import { parseQuickCheckinRequirements } from "./quickCheckinRequirements";

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
      ? "maxRiders must be a whole number of 1 or more" : null) ??
    checkEventDateOrder(body) ??
    checkPurchaseOptions(body.purchaseOptions) ??
    (body.quickCheckinRequirements === undefined ? null : quickCheckinRequirementsError(body.quickCheckinRequirements))
  );
}

function quickCheckinRequirementsError(input: unknown): string | null {
  const parsed = parseQuickCheckinRequirements(input);
  return "error" in parsed ? parsed.error : null;
}

// Registration may close in the evening of the last race day in any US time zone,
// which is the next day in UTC: allow that much slack past the day's UTC end.
const LAST_DAY_SLACK_MS = 14 * 60 * 60 * 1000;

/**
 * Ordering between event dates that are present in the body (a partial update
 * only checks the pairs it sends). Run after checkDates, so values are well formed.
 */
export function checkEventDateOrder(body: Record<string, unknown>): string | null {
  const day = (v: unknown) => (isBlank(v) ? null : String(v).substring(0, 10));
  const opens = isBlank(body.registrationOpen) ? null : new Date(String(body.registrationOpen)).getTime();
  const closes = isBlank(body.registrationClose) ? null : new Date(String(body.registrationClose)).getTime();
  if (opens != null && closes != null && closes <= opens) return "Registration must close after it opens";
  const lastDay = day(body.endDate) ?? day(body.date);
  if (closes != null && lastDay && closes > Date.parse(`${lastDay}T23:59:59.999Z`) + LAST_DAY_SLACK_MS) {
    return "Registration can't close after the last race day";
  }
  const earlyEnds = day(body.earlyBirdEndsAt);
  const raceDay = day(body.date);
  if (earlyEnds && raceDay && earlyEnds > raceDay) return "The early sign-up period can't end after the race date";
  if (!isBlank(body.earlyBirdFee) && !isBlank(body.entryFee) && Number(body.earlyBirdFee) >= Number(body.entryFee)) {
    return "The early sign-up fee must be less than the entry fee";
  }
  return null;
}

/** RM TrackR option id (mirrors lib/db); its name and price are fixed on save. */
const RM_TRACKR_ID = "rm-trackr";

/**
 * An event's configured purchase options: each needs a name and a price from
 * $0 to $100,000, and ids must be unique. The RM TrackR's name and price are
 * set on save (normalizeEventPurchaseOptions), so only its id is looked at.
 */
export function checkPurchaseOptions(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "purchaseOptions must be a list";
  const ids = new Set<string>();
  for (const o of value) {
    if (!o || typeof o !== "object") return "Each purchase option needs a name and a price";
    const opt = o as Record<string, unknown>;
    const id = isBlank(opt.id) ? null : String(opt.id);
    if (id === RM_TRACKR_ID) continue;
    if (typeof opt.name !== "string" || !opt.name.trim()) return "Each purchase option needs a name";
    const amount = typeof opt.amount === "string" && opt.amount.trim() !== "" ? Number(opt.amount) : opt.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return `Purchase option "${opt.name.trim()}" needs a price of $0 or more`;
    }
    if (amount > 100_000) return `Purchase option "${opt.name.trim()}" price is too large`;
    if (id != null) {
      if (ids.has(id)) return "Purchase options must have unique ids";
      ids.add(id);
    }
  }
  return null;
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
