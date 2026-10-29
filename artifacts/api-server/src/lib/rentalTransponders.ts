/**
 * Rental transponders belong to a rider only for the event they rented at.
 *
 * Assigning a rental links the unit to the rider in rfid_assignments for that
 * event, with an expiry the morning after the last race day. It never touches
 * the rider's own profile numbers. The link is removed automatically: when the
 * unit is marked returned, and by the sweeper below once the expiry passes, so
 * a unit handed to someone else at the next event is never credited to the
 * previous renter. Organizers don't have to clear anything.
 */
import { db, rfidAssignmentsTable } from "@workspace/db";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { logger } from "./logger";

/**
 * When a rental link expires: noon UTC the day after the event's last race day
 * (early morning the next day across US time zones), so it covers the whole
 * race day, late finishes included.
 */
export function rentalExpiry(event: { date: string; endDate?: string | null }): Date {
  const lastDay = event.endDate && event.endDate > event.date ? event.endDate : event.date;
  const [y, m, d] = lastDay.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
}

/** Remove a rider's rental link for an event (on return, or when the rental is undone). */
export async function releaseRentalLink(eventId: number, riderId: number): Promise<void> {
  await db.delete(rfidAssignmentsTable).where(and(
    eq(rfidAssignmentsTable.eventId, eventId),
    eq(rfidAssignmentsTable.riderId, riderId),
    isNotNull(rfidAssignmentsTable.expiresAt),
  ));
}

/** Delete rental links whose event is over. Returns how many were removed. */
export async function sweepExpiredRentals(now = new Date()): Promise<number> {
  const removed = await db.delete(rfidAssignmentsTable)
    .where(and(isNotNull(rfidAssignmentsTable.expiresAt), lt(rfidAssignmentsTable.expiresAt, now)))
    .returning({ id: rfidAssignmentsTable.id });
  return removed.length;
}

/** Runs the sweep every 15 minutes (and once at start). */
export function startRentalSweeper(): void {
  const run = () => {
    void sweepExpiredRentals()
      .then(n => { if (n > 0) logger.info({ removed: n }, "Expired transponder rentals released"); })
      .catch(err => logger.warn({ err }, "Rental sweeper failed"));
  };
  run();
  setInterval(run, 15 * 60_000).unref?.();
}
