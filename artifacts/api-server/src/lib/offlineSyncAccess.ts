import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Who may hold and use an offline sync token (desktop app / local server).
 * Organizers and super admins always may; staff only with the offline_mode permission.
 * Checked when the token is issued and again on every sync request that uses it.
 */
export type SyncUser = { id: number; clubId: number | null; role: string; permissions: string[] | null };

export function canUseOfflineSync(user: { role: string; permissions: string[] | null }): boolean {
  if (user.role === "super_admin" || user.role === "club_organizer") return true;
  return user.role === "staff" && (user.permissions ?? []).includes("offline_mode");
}

/** True when this user may receive other users' password hashes in sync-pull. */
export function canReceivePasswordHashes(user: { role: string }): boolean {
  return user.role === "super_admin" || user.role === "club_organizer";
}

const syncUserColumns = {
  id: usersTable.id,
  clubId: usersTable.clubId,
  role: usersTable.role,
  permissions: usersTable.permissions,
};

/**
 * Resolves the caller of a sync route from the organizer session or a Bearer
 * offline sync token. Returns null when neither identifies a user, or when the
 * user is not allowed to use offline sync.
 */
export async function resolveSyncUser(req: any): Promise<SyncUser | null> {
  const sessionUserId = (req.session as any)?.userId as number | undefined;
  let user: SyncUser | undefined;
  if (sessionUserId) {
    [user] = await db.select(syncUserColumns).from(usersTable).where(eq(usersTable.id, sessionUserId));
  } else {
    const authHeader = (req.headers.authorization ?? "") as string;
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!token) return null;
    [user] = await db.select(syncUserColumns).from(usersTable).where(eq(usersTable.offlineSyncToken, token));
  }
  if (!user || !canUseOfflineSync(user)) return null;
  return user;
}
