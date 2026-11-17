/**
 * Rider cards on the Profile tab (app) and My Profiles (website): the summary
 * line, the recent-finishes sparkline and the next maintenance item due.
 */

/** "6 events · 120 pts · best P1" (parts with nothing to show are left out). */
export function cardSummary(p: { eventsRaced: number; totalPoints: number; bestPosition: number | null }): string {
  const parts = [`${p.eventsRaced} ${p.eventsRaced === 1 ? "event" : "events"}`];
  if (p.totalPoints) parts.push(`${p.totalPoints} pts`);
  if (p.bestPosition) parts.push(`best P${p.bestPosition}`);
  return parts.join(" · ");
}

/**
 * Finishing positions from a newest-first results feed, oldest first, at most n
 * (DNF/DNS motos have no position and are skipped).
 */
export function recentFinishes(feed: Array<{ motos: Array<{ position: number | null }> }>, n = 8): number[] {
  const out: number[] = [];
  for (const item of feed) {
    for (const m of [...item.motos].reverse()) {
      if (m.position != null) out.push(m.position);
      if (out.length >= n) return out.reverse();
    }
  }
  return out.reverse();
}

export interface MaintenanceLike {
  itemName: string;
  intervalDays: number | null;
  lastServicedAt: string | null;
}

export type MaintenanceStatus = "overdue" | "due_soon" | "ok" | "unknown";

export interface NextMaintenance {
  itemName: string;
  status: MaintenanceStatus;
  /** Days until due (negative = overdue), when the item has been logged. */
  dueInDays: number | null;
  label: string;
}

const DAY = 86_400_000;

/**
 * Whole days since a service was logged. Service dates are calendar days
 * ("2026-11-16", the rider's own date when they tapped Log), so they are counted
 * as calendar days on this device. Reading one as UTC midnight made a service
 * logged in the US evening show as "1d ago" straight away, and due a day early.
 */
export function daysSinceService(lastServicedAt: string, nowMs: number): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastServicedAt.trim());
  if (!day) return Math.floor((nowMs - new Date(lastServicedAt).getTime()) / DAY);
  const now = new Date(nowMs);
  return Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(+day[1], +day[2] - 1, +day[3])) / DAY);
}

/**
 * The item that needs attention first: most overdue, then soonest due. Items
 * never logged come last. Null when the rider has no maintenance items.
 */
export function nextMaintenance(items: MaintenanceLike[], nowMs: number): NextMaintenance | null {
  if (items.length === 0) return null;
  const rated = items.map(it => {
    if (!it.lastServicedAt || !it.intervalDays) return { it, dueIn: null as number | null };
    const since = daysSinceService(it.lastServicedAt, nowMs);
    return { it, dueIn: it.intervalDays - since };
  });
  const logged = rated.filter(r => r.dueIn != null).sort((a, b) => a.dueIn! - b.dueIn!);
  const pick = logged[0] ?? rated[0];
  const { it, dueIn } = pick;
  if (dueIn == null) return { itemName: it.itemName, status: "unknown", dueInDays: null, label: `${it.itemName}: not logged yet` };
  const status: MaintenanceStatus = dueIn <= 0 ? "overdue" : dueIn <= it.intervalDays! * 0.2 ? "due_soon" : "ok";
  const label = dueIn < 0 ? `${it.itemName} overdue ${-dueIn} ${-dueIn === 1 ? "day" : "days"}`
    : dueIn === 0 ? `${it.itemName} due today`
    : `${it.itemName} due in ${dueIn} ${dueIn === 1 ? "day" : "days"}`;
  return { itemName: it.itemName, status, dueInDays: dueIn, label };
}
