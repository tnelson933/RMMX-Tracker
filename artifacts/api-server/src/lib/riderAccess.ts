import { db, ridersTable, riderAccountsTable, riderProfileManagersTable } from "@workspace/db";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

/**
 * Which rider profiles a rider account may manage:
 *  - the owner: the account whose email matches riders.email (the original rule), and
 *  - managers: accounts invited by email in rider_profile_managers (second parent, coach).
 *
 * Every rider-portal ownership check goes through here so the two rules can't drift.
 */

type Account = { id: number; email: string };

const norm = (e: string) => e.trim().toLowerCase();

/** IDs of every rider profile this account owns or manages. */
export async function managedRiderIds(account: Account): Promise<number[]> {
  const email = norm(account.email);
  const owned = await db.select({ id: ridersTable.id }).from(ridersTable)
    .where(sql`LOWER(${ridersTable.email}) = ${email}`);
  const managed = await db.select({ id: riderProfileManagersTable.riderId }).from(riderProfileManagersTable)
    .where(or(eq(riderProfileManagersTable.riderAccountId, account.id), eq(riderProfileManagersTable.invitedEmail, email)));
  return [...new Set([...owned.map(r => r.id), ...managed.map(r => r.id)])];
}

/** True when the account owns (email match) this rider. */
export function ownsRider(account: Account, rider: { email: string | null }): boolean {
  return !!rider.email && norm(rider.email) === norm(account.email);
}

/** True when the account owns or manages this rider. Links a pending invite to the account on first use. */
export async function canManageRider(account: Account, rider: { id: number; email: string | null }): Promise<boolean> {
  if (ownsRider(account, rider)) return true;
  const email = norm(account.email);
  const [row] = await db.select({ id: riderProfileManagersTable.id, riderAccountId: riderProfileManagersTable.riderAccountId })
    .from(riderProfileManagersTable)
    .where(and(eq(riderProfileManagersTable.riderId, rider.id),
      or(eq(riderProfileManagersTable.riderAccountId, account.id), eq(riderProfileManagersTable.invitedEmail, email))));
  if (!row) return false;
  if (row.riderAccountId == null) {
    await db.update(riderProfileManagersTable).set({ riderAccountId: account.id })
      .where(and(eq(riderProfileManagersTable.id, row.id), isNull(riderProfileManagersTable.riderAccountId)));
  }
  return true;
}

/** WHERE clause on ridersTable selecting every profile this account owns or manages. */
export async function managedRiderWhere(account: Account): Promise<SQL> {
  const ids = await managedRiderIds(account);
  return ids.length ? inArray(ridersTable.id, ids) : sql`false`;
}

/**
 * Each rider's app accounts: the account with the rider's email, plus invited
 * managers. Same matching as accountIdsForRiders, kept per rider (for
 * reminders that report who was reached).
 */
export async function accountIdsByRider(riderIds: number[]): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>(riderIds.map(id => [id, []]));
  if (riderIds.length === 0) return result;
  const riders = await db.select({ id: ridersTable.id, email: ridersTable.email }).from(ridersTable).where(inArray(ridersTable.id, riderIds));
  const managers = await db.select({ riderId: riderProfileManagersTable.riderId, accountId: riderProfileManagersTable.riderAccountId, email: riderProfileManagersTable.invitedEmail })
    .from(riderProfileManagersTable).where(inArray(riderProfileManagersTable.riderId, riderIds));
  const emails = [...new Set([
    ...riders.map(r => r.email?.trim().toLowerCase()).filter((e): e is string => !!e),
    ...managers.map(m => m.email?.trim().toLowerCase()).filter((e): e is string => !!e),
  ])];
  const accounts = emails.length
    ? await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email }).from(riderAccountsTable).where(inArray(sql`LOWER(${riderAccountsTable.email})`, emails))
    : [];
  const idByEmail = new Map(accounts.map(a => [a.email.trim().toLowerCase(), a.id]));
  const add = (riderId: number, accountId: number | null | undefined) => {
    if (accountId == null) return;
    const list = result.get(riderId)!;
    if (!list.includes(accountId)) list.push(accountId);
  };
  for (const r of riders) add(r.id, r.email ? idByEmail.get(r.email.trim().toLowerCase()) : undefined);
  for (const m of managers) {
    add(m.riderId, m.accountId);
    add(m.riderId, m.email ? idByEmail.get(m.email.trim().toLowerCase()) : undefined);
  }
  return result;
}

/** Rider accounts that own or manage any of these riders (for race-day push alerts). */
export async function accountIdsForRiders(riderIds: number[]): Promise<number[]> {
  if (riderIds.length === 0) return [];
  const emails = (await db.select({ email: ridersTable.email }).from(ridersTable).where(inArray(ridersTable.id, riderIds)))
    .map(r => r.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  const managers = await db.select({ accountId: riderProfileManagersTable.riderAccountId, email: riderProfileManagersTable.invitedEmail })
    .from(riderProfileManagersTable).where(inArray(riderProfileManagersTable.riderId, riderIds));
  const allEmails = [...new Set([...emails, ...managers.map(m => m.email)])];
  const byEmail = allEmails.length
    ? await db.select({ id: riderAccountsTable.id }).from(riderAccountsTable).where(inArray(sql`LOWER(${riderAccountsTable.email})`, allEmails))
    : [];
  return [...new Set([...byEmail.map(a => a.id), ...managers.map(m => m.accountId).filter((id): id is number => id != null)])];
}
