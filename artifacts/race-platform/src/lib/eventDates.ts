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
