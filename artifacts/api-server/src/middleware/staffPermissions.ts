import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * A rule for a staff permission check:
 *  - pattern: matched against req.path (already stripped of /api prefix by Express mount)
 *  - permissions: [] = allow any authenticated staff | string[] = any-of match | null = always block
 *  - methods: if provided, rule only applies to those HTTP methods
 */
type RouteRule = {
  pattern: RegExp;
  permissions: string[] | null;
  methods?: HttpMethod[];
};

/**
 * Ordered list of rules for staff users.
 * First matching rule wins.
 * If no rule matches → 403 (default-deny for staff).
 */
const STAFF_RULES: RouteRule[] = [
  // ── Always allowed (auth, health, public data, rider portal) ──────────────
  { pattern: /^\/auth(\/|$)/, permissions: [] },
  { pattern: /^\/healthz(\/|$)/, permissions: [] },
  { pattern: /^\/public(\/|$)/, permissions: [] },
  { pattern: /^\/rider(\/|$)/, permissions: [] },
  { pattern: /^\/stripe\/webhook/, permissions: [] },

  // ── Rider-level discount-code assignment (discount_codes, all methods) ────
  // Must come before the clubs read-only rule so POST/DELETE are not blocked.
  { pattern: /^\/clubs\/\d+\/riders\/\d+\/discount-code/, permissions: ["discount_codes"] },

  // ── Clubs: read-only acceptable (used by gate page for event lookup) ──────
  { pattern: /^\/clubs(\/|$)/, permissions: [], methods: ["GET", "HEAD"] },

  // ── Standalone moto actions (/motos/:id, /motos/:id/restart) ─────────────
  // These are PATCH/POST/DELETE routes not under /events/:id path.
  { pattern: /^\/motos(\/|$)/, permissions: ["events"] },

  // ── Motos under events: read-only for gate_schedule; writes need events ───
  { pattern: /^\/events\/\d+\/motos/, permissions: ["events", "gate_schedule"], methods: ["GET", "HEAD"] },
  { pattern: /^\/events\/\d+\/motos/, permissions: ["events"] }, // non-GET

  // ── SSE timing feed: read-only for gate_schedule; write methods need events ─
  { pattern: /^\/timing(\/|$)/, permissions: ["events", "gate_schedule"], methods: ["GET", "HEAD"] },
  { pattern: /^\/timing(\/|$)/, permissions: ["events"] }, // non-GET (crossing ingestion) needs events

  // ── Event-nested organizer data: requires events (NOT gate_schedule) ───────
  // These MUST come before the general ^/events rule so that the broad
  // gate_schedule-read rule does not accidentally match these sub-paths.
  { pattern: /^\/events\/\d+\/registrations/, permissions: ["events"] },
  { pattern: /^\/events\/\d+\/checkins/, permissions: ["events"] },
  { pattern: /^\/events\/\d+\/results/, permissions: ["events"] },
  { pattern: /^\/events\/\d+\/ama-export/, permissions: ["events"] },

  // ── Events list/detail: read-only for gate_schedule; writes need events ───
  { pattern: /^\/events(\/|$)/, permissions: ["events", "gate_schedule"], methods: ["GET", "HEAD"] },
  { pattern: /^\/events(\/|$)/, permissions: ["events"] }, // non-GET

  // ── Direct registration/checkin/result mutations (PATCH /registrations/:id etc.) ─
  { pattern: /^\/registrations(\/|$)/, permissions: ["events"] },
  { pattern: /^\/checkins(\/|$)/, permissions: ["events"] },
  { pattern: /^\/results(\/|$)/, permissions: ["events"] },
  { pattern: /^\/export(\/|$)/, permissions: ["events"] },
  { pattern: /^\/video(\/|$)/, permissions: ["events"] },
  { pattern: /^\/sync(\/|$)/, permissions: ["events"] },
  { pattern: /^\/storage(\/|$)/, permissions: ["events", "riders", "dashboard", "practice"] },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  { pattern: /^\/dashboard(\/|$)/, permissions: ["dashboard"] },

  // ── Practice ─────────────────────────────────────────────────────────────
  { pattern: /^\/practice(\/|$)/, permissions: ["practice"] },

  // ── Riders ────────────────────────────────────────────────────────────────
  { pattern: /^\/riders(\/|$)/, permissions: ["riders"] },

  // ── Reader setup / RFID ───────────────────────────────────────────────────
  { pattern: /^\/rfid(\/|$)/, permissions: ["reader_setup"] },

  // ── Offline mode ──────────────────────────────────────────────────────────
  { pattern: /^\/offline(\/|$)/, permissions: ["offline_mode"] },

  // ── Series ────────────────────────────────────────────────────────────────
  { pattern: /^\/series(\/|$)/, permissions: ["series"] },

  // ── Points scoring tables + AI helper ────────────────────────────────────
  { pattern: /^\/points-tables(\/|$)/, permissions: ["points_tables"] },
  { pattern: /^\/ai(\/|$)/, permissions: ["points_tables"] },

  // ── Payments / Stripe Connect ─────────────────────────────────────────────
  { pattern: /^\/stripe-connect(\/|$)/, permissions: ["payments"] },

  // ── Discount codes and discount categories ────────────────────────────────
  // Matches /discount-codes and /discount-categories (note: pattern uses hyphen, not slash).
  { pattern: /^\/discount-/, permissions: ["discount_codes"] },

  // ── Team management: never for staff ─────────────────────────────────────
  { pattern: /^\/organizer\/team(\/|$)/, permissions: null },

  // ── Super-admin user management: never for staff ──────────────────────────
  { pattern: /^\/users(\/|$)/, permissions: null },
];

export async function staffPermissionMiddleware(req: Request, res: Response, next: NextFunction) {
  const sessionUserId = (req.session as any)?.userId;
  if (!sessionUserId) return next(); // unauthenticated — route handlers return 401

  const path = req.path;
  const method = req.method.toUpperCase() as HttpMethod;

  // Fetch the user's role, permissions, and clubId (fresh from DB for correctness)
  const [user] = await db
    .select({ role: usersTable.role, permissions: usersTable.permissions, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, sessionUserId));

  if (!user) return next(); // stale session — let auth handlers deal with it

  // Organizers and admins are never restricted here
  if (user.role !== "staff") return next();

  const staffPerms: string[] = user.permissions ?? [];

  // Safety: a staff account without a clubId would bypass all club-scoping checks.
  // Deny immediately rather than risk unscoped data access.
  if (user.clubId == null) {
    return res.status(403).json({ error: "Forbidden: staff account has no club assignment" });
  }

  // Expose staff clubId via res.locals so route handlers can enforce club ownership.
  // Route handlers must read res.locals.staffClubId and apply it as a scope guard.
  res.locals.staffClubId = user.clubId;

  // Find the first rule whose pattern matches AND whose method list (if any) includes this request method
  for (const rule of STAFF_RULES) {
    if (!rule.pattern.test(path)) continue;
    if (rule.methods && !rule.methods.includes(method)) continue;

    // Rule matched
    if (rule.permissions === null) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (rule.permissions.length === 0) {
      return next(); // unconditionally allowed
    }
    const hasAny = rule.permissions.some((p) => staffPerms.includes(p));
    if (!hasAny) {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  }

  // Default-deny: no rule matched → staff cannot access this route
  return res.status(403).json({ error: "Forbidden" });
}
