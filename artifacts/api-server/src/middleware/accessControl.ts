import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { applyStaffRules } from "./staffPermissions";

/**
 * Default-deny access control for everything mounted under /api.
 *
 * 1. Routes in PUBLIC_RULES are reachable without an organizer session. Route
 *    handlers that need a rider session or a token still enforce it themselves.
 * 2. Desktop/local-server sync routes accept a Bearer sync token, validated by
 *    the handler (resolveClubUser / sync.ts).
 * 3. Everything else requires an organizer-portal session (users table).
 *    - super_admin: unrestricted.
 *    - staff: per-permission rules in staffPermissions.ts, scoped to their club.
 *    - club_organizer and any other role: scoped to their own club by setting
 *      res.locals.staffClubId, which every route's ownership helper reads as
 *      "the club this caller is limited to".
 *
 * Public read routes stay unscoped (no staffClubId) for organizers and staff so a
 * signed-in user can still browse other clubs' public results, as before. For
 * every signed-in user res.locals.callerClubId / callerIsSuperAdmin are set
 * first; use callerOwnsClub() wherever a public route shows the owner more.
 */

type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type PublicRule = { pattern: RegExp; methods?: HttpMethod[]; reason: string };

const READ: HttpMethod[] = ["GET", "HEAD"];

export const PUBLIC_RULES: PublicRule[] = [
  // Handlers own their auth (login/setup/me return 401 themselves; rider routes use rider sessions/tokens).
  { pattern: /^\/healthz$/, reason: "health check" },
  { pattern: /^\/auth(\/|$)/, reason: "login, setup, me" },
  { pattern: /^\/rider(\/|$)/, reason: "rider portal + mobile app (rider auth in handlers)" },
  { pattern: /^\/public(\/|$)/, reason: "public website and registration" },
  { pattern: /^\/account-deletion-request$/, methods: ["POST"], reason: "public account deletion request" },
  { pattern: /^\/stripe\/webhook$/, methods: ["POST"], reason: "Stripe webhook (signature checked)" },
  { pattern: /^\/stripe\/connect\/return$/, methods: READ, reason: "Stripe onboarding redirect" },
  { pattern: /^\/stripe\/clubs\/\d+\/status$/, methods: READ, reason: "club Stripe connected yes/no (desktop local server)" },
  { pattern: /^\/events\/\d+\/quick-checkin$/, methods: ["POST"], reason: "rider quick check-in (rider session checked in handler)" },

  // Read-only race data shown on public pages, gate pages, widgets and the rider app.
  { pattern: /^\/config\/(desktop|connector)-release$/, methods: READ, reason: "download links" },
  { pattern: /^\/connector\/pair$/, methods: ["POST"], reason: "RM Connect pairing (code-authenticated, rate limited)" },
  { pattern: /^\/events$/, methods: READ, reason: "public results list" },
  { pattern: /^\/events\/\d+$/, methods: READ, reason: "public event page" },
  { pattern: /^\/events\/\d+\/(motos|results|penalty-summary)$/, methods: READ, reason: "public schedule/results/penalties (unpublished shown to the owning club only)" },
  { pattern: /^\/series\/\d+\/leaderboard$/, methods: READ, reason: "public series leaderboard" },
  { pattern: /^\/timing\/(live|leaderboard|announcer-live|crossings)\/\d+$/, methods: READ, reason: "live timing views" },
  { pattern: /^\/timing\/announcer-audio\/\d+$/, methods: READ, reason: "watch-live announcer audio" },
  { pattern: /^\/timing\/rmonitor-(feed|snapshot|status)$/, methods: READ, reason: "scoreboard feed" },
  { pattern: /^\/video\/(live-events|status\/\d+)$/, methods: READ, reason: "watch-live video status" },
  { pattern: /^\/practice\/\d+\/live$/, methods: READ, reason: "practice live SSE (handler: own club, or a rider account's own riders only)" },
  { pattern: /^\/storage\/(objects|public-objects|uploads)\//, methods: READ, reason: "images and logos" },

  // Timing hardware ingest. Not yet authenticated: tracked separately (audit S11).
  { pattern: /^\/timing\/(crossing|impinj-crossing|zebra-crossing|active\/crossing|ping)$/, methods: ["POST"], reason: "reader ingest (S11 pending)" },
  { pattern: /^\/timing\/readers\/[^/]+\/(crossing|active\/crossing|ping)$/, methods: ["POST"], reason: "per-reader token ingest (token checked in handler)" },
  { pattern: /^\/practice\/(\d+|active)\/crossing$/, methods: ["POST"], reason: "practice reader ingest (S11 pending)" },
];

const BEARER_SYNC_ROUTE = /^\/clubs\/\d+\/(sync|sync-pull|desktop-push)$/;
// Paired RM Connect laptops send their laptop key; the handler validates it.
const BEARER_LAPTOP_ROUTE = /^\/connector\/laptop\//;

export function isPublicRoute(path: string, method: string): boolean {
  const m = method.toUpperCase() as HttpMethod;
  return PUBLIC_RULES.some(r => r.pattern.test(path) && (!r.methods || r.methods.includes(m)));
}

export async function accessControlMiddleware(req: Request, res: Response, next: NextFunction) {
  const path = req.path;
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return next();

  const isPublic = isPublicRoute(path, method);
  const sessionUserId = (req.session as any)?.userId as number | undefined;

  if (!sessionUserId) {
    if (isPublic) return next();
    const auth = req.headers.authorization ?? "";
    if (BEARER_SYNC_ROUTE.test(path) && auth.startsWith("Bearer ")) return next();
    if (BEARER_LAPTOP_ROUTE.test(path) && auth.startsWith("Bearer ")) return next();
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Mirroring (a super admin acting as an organizer): Quit always works, the
  // mirror picker answers the super admin, and the desktop app's offline sign-in
  // and sync can't be used to take the organizer's credentials or data away.
  if ((req.session as any)?.mirrorBy) {
    if (path === "/admin/mirror/stop" || path === "/admin/mirror/organizers") return next();
    // Includes pairing codes: a laptop key is a lasting club credential.
    if (path === "/auth/offline-token" || path === "/readers/pairing-codes" || /^\/clubs\/\d+\/(sync-pull|desktop-push)$/.test(path)) {
      return res.status(403).json({ error: "Not available while mirroring an organizer" });
    }
  }

  const [user] = await db
    .select({ role: usersTable.role, permissions: usersTable.permissions, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, sessionUserId));

  if (!user) {
    // Stale session (user deleted): treat as logged out.
    if (isPublic) return next();
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Who the signed-in caller is, set before any public-route return so public
  // handlers can tell the owning club (e.g. unpublished results) from everyone else.
  res.locals.callerIsSuperAdmin = user.role === "super_admin";
  if (user.clubId != null) res.locals.callerClubId = user.clubId;

  if (user.role === "super_admin") return next();

  // Public read routes stay reachable for organizers and staff (whatever their
  // permissions) and unscoped, so they can browse any club's public pages.
  // Handlers that reveal more to the owning club check res.locals.callerClubId.
  if (isPublic) return next();

  if (user.role === "staff") return applyStaffRules(user, path, method, res, next);

  if (user.clubId == null) {
    return res.status(403).json({ error: "Forbidden: account has no club assignment" });
  }
  res.locals.staffClubId = user.clubId;
  return next();
}

/**
 * True when the signed-in caller belongs to this club (or is a super admin).
 * Works on public routes too, where staffClubId is deliberately not set.
 */
export function callerOwnsClub(res: Response, clubId: number | null | undefined): boolean {
  if (res.locals.callerIsSuperAdmin === true) return true;
  const callerClubId = res.locals.callerClubId;
  return typeof callerClubId === "number" && clubId != null && callerClubId === clubId;
}
