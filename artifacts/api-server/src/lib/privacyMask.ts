/**
 * Partly hidden contact details for people who look up an email without being
 * signed in as that rider (or an organizer): enough to recognize their own
 * details, not enough to learn someone else's. A value containing "*" sent
 * back with a registration means "keep what's on file".
 */

const MASK = "*";

/** True when a submitted value is (or still contains) a hidden one. */
export function isMasked(value: unknown): boolean {
  return typeof value === "string" && value.includes(MASK);
}

/** Phone: only the last 4 digits, e.g. "***-***-0100". */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return `***-***-${digits.slice(-4).padStart(4, MASK)}`;
}

/** Name: the first letter of each word, e.g. "Jane Smith" → "J*** S****". */
export function maskName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/).filter(Boolean)
    .map(w => w[0] + MASK.repeat(Math.max(2, Math.min(w.length - 1, 6))))
    .join(" ");
}

/** Date of birth: the year only; month and day become asterisks (MM/DD/2008 style). */
export function maskDateOfBirth(dob: string | null | undefined): string {
  const s = (dob ?? "").trim();
  if (!s) return "";
  const year = s.match(/\b(19|20)\d{2}\b/)?.[0];
  return `**/**/${year ?? "****"}`;
}

/** Street address: numbers hidden, street name kept, e.g. "8648 S 5200 W" → "**** S **** W". */
export function maskStreet(street: string | null | undefined): string {
  const s = (street ?? "").trim();
  return s ? s.replace(/\d/g, MASK) : "";
}

/** ZIP: the first 2 digits, e.g. "84651" → "84***". */
export function maskZip(zip: string | null | undefined): string {
  const s = (zip ?? "").trim();
  if (!s) return "";
  return s.slice(0, 2) + s.slice(2).replace(/[0-9A-Za-z]/g, MASK);
}
