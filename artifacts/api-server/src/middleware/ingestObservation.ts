/**
 * Phase 0 of the timing ingest auth plan (docs/timing-ingest-auth-plan.md):
 * observe who posts to the crossing ingest routes, without changing behavior.
 *
 * Logs one line per ingest request after the response is sent. It records which
 * credential was presented (never its value) and the club/event/moto the request
 * addressed, so we can see which callers still post unauthenticated before any
 * route starts rejecting them.
 *
 * Nothing here awaits, so request handling and crossing receipt time are
 * unaffected; the log line is written from the response "finish" event.
 */
import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger";

const INGEST_ROUTES: Array<[RegExp, string]> = [
  [/^\/timing\/readers\/[^/]+\/crossing\/?$/, "reader_token_crossing"],
  [/^\/timing\/crossing\/?$/, "crossing"],
  [/^\/timing\/active\/crossing\/?$/, "active_crossing"],
  [/^\/timing\/ping\/?$/, "ping"],
  [/^\/timing\/impinj-crossing\/?$/, "impinj_crossing"],
  [/^\/timing\/zebra-crossing\/?$/, "zebra_crossing"],
  [/^\/timing\/mylaps-crossing\/?$/, "active_legacy_crossing"],
  [/^\/practice\/active\/crossing\/?$/, "practice_active_crossing"],
];

export function classifyIngestRoute(method: string, path: string): string | null {
  if (method.toUpperCase() !== "POST") return null;
  for (const [pattern, label] of INGEST_ROUTES) {
    if (pattern.test(path)) return label;
  }
  return null;
}

export type IngestCredential = "reader_path_token" | "bearer" | "session" | "none";

export function classifyIngestCredential(opts: {
  route: string;
  hasAuthorizationHeader: boolean;
  hasSessionUser: boolean;
}): IngestCredential {
  if (opts.route === "reader_token_crossing") return "reader_path_token";
  if (opts.hasAuthorizationHeader) return "bearer";
  if (opts.hasSessionUser) return "session";
  return "none";
}

function idHint(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function ingestObservationMiddleware(req: Request, res: Response, next: NextFunction) {
  const route = classifyIngestRoute(req.method, req.path);
  if (!route) return next();

  res.on("finish", () => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const credential = classifyIngestCredential({
      route,
      hasAuthorizationHeader: typeof req.headers.authorization === "string",
      hasSessionUser: !!(req.session as any)?.userId,
    });
    logger.info(
      {
        timingIngest: {
          route,
          credential,
          clubIdHint: idHint(req.query.clubId),
          eventIdHint: idHint(req.query.eventId ?? body.eventId),
          motoIdHint: idHint(body.motoId),
          staffClubId: typeof res.locals.staffClubId === "number" ? res.locals.staffClubId : null,
          status: res.statusCode,
          userAgent: req.headers["user-agent"]?.slice(0, 120) ?? null,
        },
      },
      "timing ingest observed",
    );
  });
  return next();
}
