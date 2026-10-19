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
 * Public read routes stay unscoped for organizers so a signed-in organizer can
 * still browse other clubs' public results, as before.
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
  { pattern: /^\/events\/\d+\/quick-checkin$/, methods: ["POST"], reason: "rider quick check-in (rider session checked in handler)" },

  // Read-only race data shown on public pages, gate pages, widgets and the rider app.
  { pattern: /^\/config\/(desktop|connector)-release$/, methods: READ, reason: "download links" },
  { pattern: /^\/events$/, methods: READ, reason: "public results list" },
  { pattern: /^\/events\/\d+$/, methods: READ, reason: "public event page" },
  { pattern: /^\/events\/\d+\/(motos|results)$/, methods: READ, reason: "public schedule/results (unpublished hidden for anonymous)" },
  { pattern: /^\/series\/\d+\/leaderboard$/, methods: READ, reason: "public series leaderboard" },
  { pattern: /^\/timing\/(live|leaderboard|announcer-live|crossings)\/\d+$/, methods: READ, reason: "live timing views" },
  { pattern: /^\/timing\/announcer-audio\/\d+$/, methods: READ, reason: "watch-live announcer audio" },
  { pattern: /^\/timing\/rmonitor-(feed|snapshot|status)$/, methods: READ, reason: "scoreboard feed" },
  { pattern: /^\/video\/(live-events|status\/\d+)$/, methods: READ, reason: "watch-live video status" },
  { pattern: /^\/storage\/(objects|public-objects|uploads)\//, methods: READ, reason: "images and logos" },

  // Timing hardware ingest. Not yet authenticated: tracked separately (audit S11).
  { pattern: /^\/timing\/(crossing|impinj-crossing|zebra-crossing|mylaps-crossing|active\/crossing|ping)$/, methods: ["POST"], reason: "reader ingest (S11 pending)" },
  { pattern: /^\/timing\/readers\/[^/]+\/crossing$/, methods: ["POST"], reason: "per-reader token ingest" },
  { pattern: /^\/practice\/(\d+|active)\/crossing$/, methods: ["POST"], reason: "practice reader ingest (S11 pending)" },
];

const BEARER_SYNC_ROUTE = /^\/clubs\/\d+\/(sync|sync-pull|desktop-push)$/;

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
    return res.status(401).json({ error: "Not authenticated" });
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

  if (user.role === "super_admin") return next();
  if (user.role === "staff") return applyStaffRules(user, path, method, res, next);

  if (isPublic) return next();
  if (user.clubId == null) {
    return res.status(403).json({ error: "Forbidden: account has no club assignment" });
  }
  res.locals.staffClubId = user.clubId;
  return next();
}
