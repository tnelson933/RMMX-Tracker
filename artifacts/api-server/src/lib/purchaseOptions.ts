import type { PurchaseOption } from "@workspace/db";

/**
 * Resolve a client's selected purchase options against the event's configured
 * options. Prices always come from the event, never from the request body:
 * clients may send option ids or `{ id }` objects, and any client-supplied
 * `amount`/`name` is ignored. Unknown ids and duplicates are dropped.
 */
export function resolvePurchaseOptions(submitted: unknown, configured: PurchaseOption[] | null | undefined): PurchaseOption[] {
  if (!Array.isArray(submitted) || !Array.isArray(configured)) return [];
  const byId = new Map(configured.map(o => [String(o.id), o]));
  const seen = new Set<string>();
  const out: PurchaseOption[] = [];
  for (const item of submitted) {
    const id = typeof item === "string" || typeof item === "number"
      ? String(item)
      : item && typeof item === "object" && "id" in item ? String((item as { id: unknown }).id) : null;
    if (id == null || seen.has(id)) continue;
    const option = byId.get(id);
    if (!option) continue;
    const amount = Number(option.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    seen.add(id);
    out.push({ ...option, amount });
  }
  return out;
}
