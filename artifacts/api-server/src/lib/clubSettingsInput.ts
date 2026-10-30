/**
 * Checks for Admin → Forms / Race Classes / Brand Contingencies saves
 * (PUT /clubs/:clubId/settings). Riders open the waiver links at registration,
 * so only files uploaded to RM Roost's storage are accepted there.
 */

export type DefaultClass = { id: string; name: string; details?: string };

export const MAX_CLASS_NAME = 80;
export const MAX_CLASS_DETAILS = 2000;
export const MAX_CLASSES = 200;
export const MAX_BRAND_NAME = 60;
export const MAX_BRANDS = 200;
export const MAX_ACKNOWLEDGEMENT = 50_000;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** A waiver PDF link: null clears it; otherwise a file uploaded to RM Roost (/api/storage/…). */
export function checkPdfUrl(value: unknown, what: string): Result<string | null> {
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || !/^\/api\/storage\/[A-Za-z0-9/_.-]+$/.test(value) || value.includes("..")) {
    return { ok: false, error: `Upload the ${what} as a PDF with the Choose PDF button.` };
  }
  return { ok: true, value };
}

/**
 * The club's class templates with optional rules text. Blank entries and repeats
 * of a name (ignoring case and spacing) are dropped, keeping the first, so a
 * club that already has duplicates can still save.
 */
export function checkDefaultClasses(value: unknown): Result<DefaultClass[]> {
  if (!Array.isArray(value)) return { ok: false, error: "Race classes didn't save. Refresh the page and try again." };
  if (value.length > MAX_CLASSES) return { ok: false, error: `A club can keep up to ${MAX_CLASSES} race classes.` };
  const seen = new Set<string>();
  const out: DefaultClass[] = [];
  for (const raw of value) {
    const c = raw as { id?: unknown; name?: unknown; details?: unknown } | null;
    const name = typeof c?.name === "string" ? c.name.trim().replace(/\s+/g, " ") : "";
    if (!name) continue;
    if (name.length > MAX_CLASS_NAME) return { ok: false, error: `Keep class names to ${MAX_CLASS_NAME} characters or fewer.` };
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const details = typeof c?.details === "string" ? c.details.trim() : "";
    if (details.length > MAX_CLASS_DETAILS) return { ok: false, error: `Keep class rules to ${MAX_CLASS_DETAILS.toLocaleString()} characters or fewer.` };
    const id = typeof c?.id === "string" && c.id.trim() ? c.id.trim().slice(0, 64) : crypto.randomUUID();
    out.push(details ? { id, name, details } : { id, name });
  }
  return { ok: true, value: out };
}

/** Contingency brand names: trimmed; blanks and repeats (ignoring case) are dropped. */
export function checkBrands(value: unknown): Result<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: "Brands didn't save. Refresh the page and try again." };
  if (value.length > MAX_BRANDS) return { ok: false, error: `A club can keep up to ${MAX_BRANDS} brands.` };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    if (name.length > MAX_BRAND_NAME) return { ok: false, error: `Keep brand names to ${MAX_BRAND_NAME} characters or fewer.` };
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return { ok: true, value: out };
}

const FIELD_TYPES = new Set(["name", "email", "date", "signature"]);

/** Signing-field positions on the liability waiver PDF (page and 0–1 fractions of the page). */
export function checkWaiverFields(value: unknown): Result<unknown[] | null> {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.length > 100) return { ok: false, error: "The signing fields didn't save. Reopen the field editor and try again." };
  for (const raw of value) {
    const f = raw as Record<string, unknown> | null;
    const nums = ["x", "y", "width", "height"].map(k => f?.[k]);
    if (!f || !FIELD_TYPES.has(String(f.type)) || nums.some(n => typeof n !== "number" || !Number.isFinite(n))) {
      return { ok: false, error: "The signing fields didn't save. Reopen the field editor and try again." };
    }
  }
  return { ok: true, value };
}

/** Rider acknowledgement text: null clears it. */
export function checkAcknowledgement(value: unknown): Result<string | null> {
  if (value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "The acknowledgement didn't save. Refresh the page and try again." };
  if (value.length > MAX_ACKNOWLEDGEMENT) return { ok: false, error: `Keep the acknowledgement to ${MAX_ACKNOWLEDGEMENT.toLocaleString()} characters or fewer, or upload it as a PDF.` };
  return { ok: true, value };
}
