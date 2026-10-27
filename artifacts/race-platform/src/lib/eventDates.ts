import { format, parseISO } from "date-fns";

export function formatEventDates(date: string, endDate?: string | null): string {
  const start = parseISO(date.substring(0, 10));
  if (!endDate) {
    return format(start, "MMM d, yyyy");
  }
  const end = parseISO(endDate.substring(0, 10));
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${format(start, "MMM d")} – ${format(end, "d, yyyy")}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
  }
  return `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`;
}

export function formatEventDatesFull(date: string, endDate?: string | null): string {
  const start = parseISO(date.substring(0, 10));
  if (!endDate) {
    return format(start, "EEEE, MMMM d, yyyy");
  }
  const end = parseISO(endDate.substring(0, 10));
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${format(start, "MMMM d")} – ${format(end, "d, yyyy")}`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, "MMMM d")} – ${format(end, "MMMM d, yyyy")}`;
  }
  return `${format(start, "MMMM d, yyyy")} – ${format(end, "MMMM d, yyyy")}`;
}

/** The viewer's local calendar date as `YYYY-MM-DD`. */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * True when the viewer's local date falls on the event's date, or inside its
 * `date`..`endDate` range for multi-day events. Event dates are calendar
 * dates (`YYYY-MM-DD`), so they are compared as strings rather than parsed
 * through `new Date()`, which would treat them as UTC midnight.
 */
export function isEventOnLocalDate(
  date: string | null | undefined,
  endDate?: string | null,
  now: Date = new Date(),
): boolean {
  if (!date) return false;
  const start = date.substring(0, 10);
  const end = endDate ? endDate.substring(0, 10) : start;
  const today = localDateString(now);
  return today >= start && today <= (end >= start ? end : start);
}
