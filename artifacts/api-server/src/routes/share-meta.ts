/**
 * Link previews for shared website links (Open Graph / Twitter cards).
 *
 * - sharePageHandler: when the API serves the website (WEB_DIST_DIR), the
 *   pages people share (/results/:id, /register/:id, /watch/:id, /live/:motoId,
 *   /racer/:id) get index.html with that event's or rider's own title,
 *   description and picture. Everything else in the page is unchanged.
 * - GET /api/public/og/event/:id.png and /api/public/og/racer/:id.png: the
 *   1200×630 share-card pictures (lib/shareCard.ts), drawn with resvg.
 *
 * Privacy: a racer gets a preview and a card only when the profile is public
 * (lib/riderResume.ts effectiveVisibility; under-18s are private unless a
 * parent makes them public) and has results, the same rule as the public
 * /racer page. A private profile gets the site's generic preview: no name,
 * no photo. Drafts and test events get the generic preview too.
 */
import { Router, type Request, type Response } from "express";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, eventsTable, clubsTable, motosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { eventToday } from "@workspace/api-zod";
import { settleStatus } from "../lib/eventStatus";
import { buildRacerProfile, loadProfileRider } from "../lib/racerProfileView";
import {
  eventMeta, eventPhase, formatEventDates, genericMeta, injectShareMeta, placeLine, racerMeta, siteOrigin,
  type EventPage, type EventPhase, type ShareMeta,
} from "../lib/shareMeta";
import { eventCardSvg, racerCardSvg, CARD_W } from "../lib/shareCard";
import { logger } from "../lib/logger";

const router = Router();

// ── Small time-limited caches (one process; previews can be a minute stale) ──

class TtlCache<V> {
  private map = new Map<string, { at: number; value: V }>();
  constructor(private ttlMs: number, private max: number) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key: string, value: V) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { at: Date.now(), value });
  }
}

const metaCache = new TtlCache<ShareMeta | null>(60_000, 1000);
const pngCache = new TtlCache<Buffer | null>(10 * 60_000, 200);

// ── Data ─────────────────────────────────────────────────────────────────────

const validId = (raw: unknown) => {
  const s = String(raw ?? "");
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
};

type LoadedEvent = {
  id: number; name: string; date: string; endDate: string | null; trackName: string | null;
  location: string | null; state: string | null; clubName: string | null; phase: EventPhase;
};

/** A publicly shareable event with its phase, or null (missing, draft or test event). */
async function loadShareEvent(eventId: number): Promise<LoadedEvent | null> {
  const [e] = await db.select({
    id: eventsTable.id, name: eventsTable.name, date: eventsTable.date, endDate: eventsTable.endDate,
    status: eventsTable.status, registrationOpen: eventsTable.registrationOpen, registrationClose: eventsTable.registrationClose,
    trackName: eventsTable.trackName, location: eventsTable.location, state: eventsTable.state,
    trackLat: eventsTable.trackLat, trackLng: eventsTable.trackLng, isTest: eventsTable.isTest,
    clubName: clubsTable.name,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(eventsTable.id, eventId));
  if (!e || e.isTest || !e.date) return null;
  // The status it would have now (the page itself saves the change; a preview never writes).
  const status = settleStatus(e) ?? e.status;
  const phase = eventPhase({ ...e, status }, eventToday(e));
  if (!phase) return null;
  return {
    id: e.id, name: e.name, date: e.date, endDate: e.endDate ?? null, trackName: e.trackName ?? null,
    location: e.location ?? null, state: e.state ?? null, clubName: e.clubName ?? null, phase,
  };
}

/** A public profile's card details, or null for a private profile, one without results, or none. */
async function loadShareRacer(riderId: number) {
  const rider = await loadProfileRider(riderId);
  if (!rider) return null;
  const profile = await buildRacerProfile(rider, false);
  if (!profile || profile.visibility !== "public") return null;
  return {
    riderId: profile.riderId,
    name: profile.name,
    number: profile.profile.number,
    plateColor: profile.profile.plateColor,
    mainClass: profile.resume.classes[0] ?? null,
    starts: profile.stats.starts,
    wins: profile.stats.wins,
    podiums: profile.stats.podiums,
  };
}

// ── Page previews ────────────────────────────────────────────────────────────

const PAGE = /^\/(results|register|watch|live|racer)\/(\d{1,9})\/?$/;

async function metaFor(pathname: string, origin: string): Promise<ShareMeta | null> {
  const m = PAGE.exec(pathname);
  if (!m) return null;
  const [, kind, rawId] = m;
  const id = validId(rawId);
  if (!id) return null;
  const pagePath = `/${kind}/${id}`;
  if (kind === "racer") {
    const r = await loadShareRacer(id);
    return r ? racerMeta(r, origin) : null;
  }
  if (kind === "live") {
    const [moto] = await db.select({ eventId: motosTable.eventId, name: motosTable.name, raceClass: motosTable.raceClass, status: motosTable.status })
      .from(motosTable).where(eq(motosTable.id, id));
    if (!moto) return null;
    const e = await loadShareEvent(moto.eventId);
    return e ? eventMeta(e, e.phase, "live", origin, pagePath, moto) : null;
  }
  const e = await loadShareEvent(id);
  return e ? eventMeta(e, e.phase, kind as EventPage, origin, pagePath) : null;
}

let indexCache: { file: string; mtimeMs: number; checkedAt: number; html: string } | null = null;

async function indexHtml(file: string): Promise<string> {
  const now = Date.now();
  if (indexCache && indexCache.file === file && now - indexCache.checkedAt < 10_000) return indexCache.html;
  const { mtimeMs } = await stat(file);
  if (indexCache && indexCache.file === file && indexCache.mtimeMs === mtimeMs) {
    indexCache.checkedAt = now;
    return indexCache.html;
  }
  const html = await readFile(file, "utf8");
  indexCache = { file, mtimeMs, checkedAt: now, html };
  return html;
}

/**
 * Serves index.html for a shared page with that page's preview tags. Private
 * profiles, drafts, unknown ids and any error get the generic preview, which
 * is what index.html already has.
 */
export function sharePageHandler(indexFile: string) {
  return async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache");
    try {
      const origin = siteOrigin(process.env.APP_URL);
      const key = req.path.replace(/\/$/, "");
      let meta = metaCache.get(key);
      if (meta === undefined) {
        meta = await metaFor(key, origin);
        metaCache.set(key, meta);
      }
      const html = await indexHtml(indexFile);
      res.type("html").send(injectShareMeta(html, meta ?? genericMeta(origin, key)));
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, route: "share-page" }, "share preview failed; serving the plain page");
      res.sendFile(indexFile);
    }
  };
}

// ── Share-card pictures ──────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
/** api-server/assets, from src/routes (tsx) or dist (bundle), or the working directory. */
function assetsDir(): string | null {
  for (const dir of [path.resolve(here, "../../assets"), path.resolve(here, "../assets"), path.resolve(process.cwd(), "assets")]) {
    if (existsSync(path.join(dir, "fonts"))) return dir;
  }
  return null;
}

type Renderer = (svg: string) => Buffer;
type CardKit = { render: Renderer | null; logo: string | null; fallback: Buffer | null };
let kitPromise: Promise<CardKit> | null = null;

/** resvg with the Barlow fonts, loaded once. Without it (or the fonts), cards are the default picture. */
function cardKit(): Promise<CardKit> {
  kitPromise ??= (async () => {
    const dir = assetsDir();
    let fallback: Buffer | null = null;
    try { if (dir) fallback = await readFile(path.join(dir, "og", "og-default.png")); } catch { /* none */ }
    try {
      if (!dir) throw new Error("assets folder not found");
      const { Resvg } = await import("@resvg/resvg-js");
      const fontFiles = ["Barlow_600SemiBold.ttf", "Barlow_700Bold.ttf", "Barlow_800ExtraBold.ttf"].map(f => path.join(dir, "fonts", f));
      let logo: string | null = null;
      try { logo = `data:image/png;base64,${(await readFile(path.join(dir, "og", "rm-roost-banner-640.png"))).toString("base64")}`; } catch { /* text logo */ }
      const render: Renderer = svg => Buffer.from(new Resvg(svg, {
        fitTo: { mode: "width", value: CARD_W },
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Barlow" },
      }).render().asPng());
      return { render, logo, fallback };
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "share cards: resvg unavailable, serving the default card");
      return { render: null, logo: null, fallback };
    }
  })();
  return kitPromise;
}

const NO_CARD = "There's no share picture for this page.";

/** `build` returns the card's SVG, or null when the page isn't shareable (404, like the page's own data). */
async function sendCard(res: Response, key: string, build: (logo: string | null) => Promise<string | null>) {
  const kit = await cardKit();
  let png = pngCache.get(key);
  if (png === undefined) {
    const svg = await build(kit.logo);
    png = !svg ? null : kit.render ? kit.render(svg) : kit.fallback;
    pngCache.set(key, png);
  }
  if (!png) return res.status(404).json({ error: NO_CARD });
  res.setHeader("Content-Type", "image/png");
  // Link-preview crawlers fetch once and keep it; ten minutes keeps a status change from lingering.
  res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=3600");
  return res.send(png);
}

router.get("/public/og/event/:file", async (req, res) => {
  const m = /^(\d{1,9})\.png$/.exec(String(req.params.file));
  const id = m ? validId(m[1]) : null;
  if (!id) return res.status(404).json({ error: NO_CARD });
  return sendCard(res, `event:${id}`, async logo => {
    const e = await loadShareEvent(id);
    if (!e) return null;
    return eventCardSvg({ name: e.name, phase: e.phase, dates: formatEventDates(e.date, e.endDate), place: placeLine(e), club: e.clubName }, logo);
  });
});

router.get("/public/og/racer/:file", async (req, res) => {
  const m = /^(\d{1,9})\.png$/.exec(String(req.params.file));
  const id = m ? validId(m[1]) : null;
  if (!id) return res.status(404).json({ error: NO_CARD });
  return sendCard(res, `racer:${id}`, async logo => {
    const r = await loadShareRacer(id);
    return r ? racerCardSvg(r, logo) : null;
  });
});

export default router;
