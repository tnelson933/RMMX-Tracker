/**
 * Desktop push for the club's own setup: club profile, points scoring tables,
 * series, discount categories and codes, Sell Items and the rental transponder
 * inventory. Each block applies the same rules as the website's route for that
 * thing, so an edit made offline is accepted or refused exactly as it would be
 * online. Rows are raw SQLite rows (snake_case; JSON columns as strings).
 *
 * Ids: a row made on the desktop has an id of 10,000,000 or more. The cloud
 * keeps that id when no row uses it. When it can't (another club's row has it,
 * or the same thing already exists here under its natural key: a category
 * name, a code, a transponder number, a built-in sell item), the row is saved
 * under the cloud's id and the pair is returned in `remaps` so the desktop
 * renumbers its copy. Serial sequences are never moved into the desktop range.
 */
import {
  clubsTable, clubSellItemsTable, compCodesTable, discountCategoriesTable, eventsTable,
  pointsTablesTable, registrationsTable, rentalTranspondersTable, ridersTable, seriesTable,
} from "@workspace/db";
import { and, eq, inArray, max } from "drizzle-orm";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";
import { formulaError, pointsScaleError, scoringMethodError } from "./scoringTables";
import { parseSellItemName, parseSellItemPrice } from "./sellItems";

export const DESKTOP_ID_FLOOR = 10_000_000;
export const ORG_PUSH_TABLES = ["points_tables", "series", "discount_categories", "comp_codes", "club_sell_items", "rental_transponders"] as const;
export type OrgPushTable = (typeof ORG_PUSH_TABLES)[number];
/** Told to the desktop in the push reply: this cloud stores these tables (an older one ignores them). */
export const ORG_PUSH_CAPABILITY = "org_tables";

const MAX_USES_UNLIMITED = 999999;
const NO_ACCESS = "your staff role doesn't include this";

type Row = Record<string, unknown>;
type Tx = any;

export interface OrgPushContext {
  tx: Tx;
  clubId: number;
  user: { role: string; permissions: string[] | null };
  payload: Record<string, unknown>;
  deletes: Record<string, unknown>;
  results: Record<string, number>;
  skip: (table: string, row: { id?: unknown }, reason: string) => void;
  mapEventId: (raw: unknown) => number;
  /** Desktop id → cloud id, per table, for rows saved under a different id. */
  idMaps: Record<OrgPushTable, Map<number, number>>;
  remaps: Record<OrgPushTable, Array<{ localId: number; cloudId: number }>>;
  /** Follow-up work for after the transaction commits. */
  seriesToRecalculate: Set<number>;
  rescoredTables: Array<{ tableId: number; clubId: number | null }>;
}

export function newOrgPushContext(base: Pick<OrgPushContext, "tx" | "clubId" | "user" | "payload" | "deletes" | "results" | "skip" | "mapEventId">): OrgPushContext {
  const idMaps = {} as OrgPushContext["idMaps"];
  const remaps = {} as OrgPushContext["remaps"];
  for (const t of ORG_PUSH_TABLES) { idMaps[t] = new Map(); remaps[t] = []; }
  return { ...base, idMaps, remaps, seriesToRecalculate: new Set(), rescoredTables: [] };
}

const rowsOf = (ctx: OrgPushContext, table: string) => (Array.isArray(ctx.payload[table]) ? ctx.payload[table] : []) as Row[];
const deletedIds = (ctx: OrgPushContext, table: string) => (Array.isArray(ctx.deletes[table]) ? ctx.deletes[table] as unknown[] : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
const isTrue = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const textOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const parseJson = (v: unknown): unknown => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return undefined; } };
const count = (ctx: OrgPushContext, key: string) => { ctx.results[key] = (ctx.results[key] ?? 0) + 1; };

/** Organizers always may; staff need one of the permissions the website's route asks for. */
function may(ctx: OrgPushContext, ...permissions: string[]): boolean {
  if (ctx.user.role !== "staff") return true;
  return permissions.some(p => (ctx.user.permissions ?? []).includes(p));
}

function remember(ctx: OrgPushContext, table: OrgPushTable, localId: number, cloudId: number) {
  if (localId === cloudId) return;
  ctx.idMaps[table].set(localId, cloudId);
  ctx.remaps[table].push({ localId, cloudId });
}

/** The id to insert with: the desktop's own when it is in the desktop range and unused, else the cloud's next. */
async function insertId(ctx: OrgPushContext, table: any, desktopId: number): Promise<{ id?: number }> {
  if (desktopId < DESKTOP_ID_FLOOR) return {};
  const [taken] = await ctx.tx.select({ id: table.id }).from(table).where(eq(table.id, desktopId));
  return taken ? {} : { id: desktopId };
}

/**
 * When the row was made on the desktop (SQLite's UTC "YYYY-MM-DD HH:MM:SS" or
 * an ISO time), so lists ordered by creation read the same on both.
 */
function madeAt(row: Row): { createdAt?: Date } {
  const v = row.created_at;
  if (typeof v !== "string" || !v) return {};
  const at = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v);
  return isNaN(at.getTime()) || at.getTime() > Date.now() + 24 * 60 * 60_000 ? {} : { createdAt: at };
}

export const mappedId = (ctx: OrgPushContext, table: OrgPushTable, raw: unknown): number => {
  const n = Number(raw);
  return ctx.idMaps[table].get(n) ?? n;
};

/** A scoring table this club may use (a system table or its own), as an event or series reference. */
export async function usableScoringTableId(ctx: OrgPushContext, raw: unknown): Promise<number | null | undefined> {
  if (raw == null || raw === "" || !Number(raw)) return null;
  const id = mappedId(ctx, "points_tables", raw);
  const [table] = await ctx.tx.select({ clubId: pointsTablesTable.clubId }).from(pointsTablesTable).where(eq(pointsTablesTable.id, id));
  return table && (table.clubId == null || table.clubId === ctx.clubId) ? id : undefined;
}

/** One of this club's discount categories, as an event's entry-fee category. */
export async function usableCategoryId(ctx: OrgPushContext, raw: unknown): Promise<number | null | undefined> {
  if (raw == null || raw === "" || !Number(raw)) return null;
  const id = mappedId(ctx, "discount_categories", raw);
  const [cat] = await ctx.tx.select({ id: discountCategoriesTable.id }).from(discountCategoriesTable)
    .where(and(eq(discountCategoriesTable.id, id), eq(discountCategoriesTable.clubId, ctx.clubId)));
  return cat ? id : undefined;
}

// ── Before events: what events refer to ──────────────────────────────────────

export async function pushOrgBeforeEvents(ctx: OrgPushContext): Promise<void> {
  await pushClubProfile(ctx);
  await pushCompCodeDeletes(ctx);
  await pushDiscountCategories(ctx);
  await pushPointsTables(ctx);
  await pushSellItems(ctx);
}

// ── After events, riders and registrations: what refers to them ──────────────

export async function pushOrgAfterEvents(ctx: OrgPushContext, rentalsOut: (clubId: number, exec: Tx) => Promise<Map<string, { riderName: string; eventName: string }>>): Promise<void> {
  await pushSeries(ctx);
  await pushCompCodes(ctx);
  await pushRentalTransponders(ctx, rentalsOut);
  await pushPointsTableDeletes(ctx);
}

/** Club profile: the fields PATCH /clubs/:id lets an organizer change. */
async function pushClubProfile(ctx: OrgPushContext) {
  for (const row of rowsOf(ctx, "clubs")) {
    if (Number(row.id) !== ctx.clubId) { ctx.skip("clubs", row, "this club belongs to another account"); continue; }
    // Staff can't change the club profile on the website either.
    if (ctx.user.role === "staff") { ctx.skip("clubs", row, NO_ACCESS); continue; }
    const set: Record<string, unknown> = {};
    if (typeof row.name === "string" && row.name.trim()) set.name = row.name;
    if (typeof row.state === "string") set.state = row.state;
    for (const [col, key] of [["contact_email", "contactEmail"], ["contact_phone", "contactPhone"], ["logo_url", "logoUrl"], ["website", "website"], ["description", "description"]] as const) {
      if (row[col] !== undefined) set[key] = row[col] == null ? null : String(row[col]);
    }
    if (row.auto_dnf_enabled != null) set.autoDnfEnabled = isTrue(row.auto_dnf_enabled);
    if (row.auto_dnf_threshold != null && Number.isFinite(Number(row.auto_dnf_threshold))) {
      set.autoDnfThreshold = Math.min(100, Math.max(1, Math.trunc(Number(row.auto_dnf_threshold))));
    }
    if (Object.keys(set).length === 0) continue;
    await ctx.tx.update(clubsTable).set(set).where(eq(clubsTable.id, ctx.clubId));
    count(ctx, "clubs");
  }
}

async function pushDiscountCategories(ctx: OrgPushContext) {
  for (const id of deletedIds(ctx, "discount_categories")) {
    if (!may(ctx, "discount_codes")) { ctx.skip("discount_categories_deleted", { id }, NO_ACCESS); continue; }
    const [row] = await ctx.tx.select({ id: discountCategoriesTable.id }).from(discountCategoriesTable)
      .where(and(eq(discountCategoriesTable.id, id), eq(discountCategoriesTable.clubId, ctx.clubId)));
    if (!row) continue; // already removed
    const [inUse] = await ctx.tx.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.entryFeeCategoryId, id)).limit(1);
    if (inUse) { ctx.skip("discount_categories_deleted", { id }, `the category is the entry-fee category of "${inUse.name}"`); continue; }
    await ctx.tx.delete(discountCategoriesTable).where(eq(discountCategoriesTable.id, id));
    count(ctx, "discount_categories_deleted");
  }
  for (const row of rowsOf(ctx, "discount_categories")) {
    const id = Number(row.id);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!id) { ctx.skip("discount_categories", row, "missing id"); continue; }
    if (!may(ctx, "discount_codes")) { ctx.skip("discount_categories", row, NO_ACCESS); continue; }
    if (!name) { ctx.skip("discount_categories", row, "Enter a name."); continue; }
    const clubCats = await ctx.tx.select({ id: discountCategoriesTable.id, name: discountCategoriesTable.name })
      .from(discountCategoriesTable).where(eq(discountCategoriesTable.clubId, ctx.clubId)) as Array<{ id: number; name: string }>;
    const sameId = clubCats.find(c => c.id === id);
    const sameName = clubCats.find(c => c.name === name);
    if (sameId) {
      if (sameName && sameName.id !== id) { ctx.skip("discount_categories", row, "another category already has this name"); continue; }
      if (sameId.name !== name) await ctx.tx.update(discountCategoriesTable).set({ name }).where(eq(discountCategoriesTable.id, id));
    } else if (sameName) {
      // The same category was added on the website too: it is that one.
      remember(ctx, "discount_categories", id, sameName.id);
    } else {
      const [made] = await ctx.tx.insert(discountCategoriesTable)
        .values({ ...(await insertId(ctx, discountCategoriesTable, id)), ...madeAt(row), clubId: ctx.clubId, name }).returning({ id: discountCategoriesTable.id });
      remember(ctx, "discount_categories", id, made.id);
    }
    count(ctx, "discount_categories");
  }
}

/** The website's checks for a scoring table (POST/PATCH /points-tables). */
function pointsTableFields(row: Row): { error: string } | { fields: Record<string, unknown> } {
  const name = typeof row.name === "string" ? row.name : "";
  const scale = parseJson(row.points_scale);
  if (!name || !row.scoring_method || !Array.isArray(scale)) return { error: "Enter a name, choose a scoring method, and fill in the points." };
  const formula = row.scoring_formula == null || row.scoring_formula === "" ? null : row.scoring_formula;
  const error = scoringMethodError(row.scoring_method) ?? pointsScaleError(scale) ?? formulaError(formula);
  if (error) return { error };
  return {
    fields: {
      name,
      description: typeof row.description === "string" ? row.description : "",
      scoringMethod: String(row.scoring_method),
      mainEventOnly: isTrue(row.main_event_only),
      pointsScale: scale,
      scoringFormula: formula as string | null,
      autoDnfEnabled: isTrue(row.auto_dnf_enabled),
      autoDnfThreshold: row.auto_dnf_threshold != null && Number.isFinite(Number(row.auto_dnf_threshold)) ? Number(row.auto_dnf_threshold) : 75,
    },
  };
}

async function pushPointsTables(ctx: OrgPushContext) {
  for (const row of rowsOf(ctx, "points_tables")) {
    const id = Number(row.id);
    if (!id) { ctx.skip("points_tables", row, "missing id"); continue; }
    // Built-in tables are the same everywhere and can't be edited.
    if (row.club_id == null || isTrue(row.is_system_default)) continue;
    if (!may(ctx, "points_tables")) { ctx.skip("points_tables", row, NO_ACCESS); continue; }
    const checked = pointsTableFields(row);
    if ("error" in checked) { ctx.skip("points_tables", row, checked.error); continue; }
    const [existing] = await ctx.tx.select().from(pointsTablesTable)
      .where(and(eq(pointsTablesTable.id, id), eq(pointsTablesTable.clubId, ctx.clubId)));
    if (existing) {
      if (existing.isSystemDefault) { ctx.skip("points_tables", row, "Built-in scoring tables can't be edited. Make a copy, then edit the copy."); continue; }
      const f = checked.fields;
      const scoringChanged = existing.scoringMethod !== f.scoringMethod || existing.mainEventOnly !== f.mainEventOnly
        || JSON.stringify(existing.pointsScale) !== JSON.stringify(f.pointsScale) || (existing.scoringFormula ?? null) !== f.scoringFormula
        || existing.autoDnfEnabled !== f.autoDnfEnabled || existing.autoDnfThreshold !== f.autoDnfThreshold;
      await ctx.tx.update(pointsTablesTable).set(f).where(eq(pointsTablesTable.id, id));
      if (scoringChanged) ctx.rescoredTables.push({ tableId: id, clubId: existing.clubId });
    } else {
      const [made] = await ctx.tx.insert(pointsTablesTable)
        .values({ ...(await insertId(ctx, pointsTablesTable, id)), ...madeAt(row), clubId: ctx.clubId, isSystemDefault: false, ...checked.fields })
        .returning({ id: pointsTablesTable.id });
      remember(ctx, "points_tables", id, made.id);
    }
    count(ctx, "points_tables");
  }
}

/** After events and series, so a table taken off them in the same push can go (DELETE /points-tables/:id). */
async function pushPointsTableDeletes(ctx: OrgPushContext) {
  for (const id of deletedIds(ctx, "points_tables")) {
    if (!may(ctx, "points_tables")) { ctx.skip("points_tables_deleted", { id }, NO_ACCESS); continue; }
    const [existing] = await ctx.tx.select().from(pointsTablesTable)
      .where(and(eq(pointsTablesTable.id, id), eq(pointsTablesTable.clubId, ctx.clubId)));
    if (!existing) continue; // already removed (or never this club's)
    if (existing.isSystemDefault) { ctx.skip("points_tables_deleted", { id }, "Built-in scoring tables can't be deleted."); continue; }
    const [series] = await ctx.tx.select({ name: seriesTable.name }).from(seriesTable).where(eq(seriesTable.scoringTableId, id)).limit(1);
    if (series) { ctx.skip("points_tables_deleted", { id }, `This scoring table is used by a series: "${series.name}". Remove it from that series before deleting.`); continue; }
    const [event] = await ctx.tx.select({ name: eventsTable.name }).from(eventsTable).where(eq(eventsTable.scoringTableId, id)).limit(1);
    if (event) { ctx.skip("points_tables_deleted", { id }, `This scoring table is used by an event: "${event.name}". Remove it from that event before deleting.`); continue; }
    await ctx.tx.delete(pointsTablesTable).where(eq(pointsTablesTable.id, id));
    count(ctx, "points_tables_deleted");
  }
}

/** Series (POST/PATCH /series). The website has no way to delete one, so neither does a push. */
async function pushSeries(ctx: OrgPushContext) {
  for (const row of rowsOf(ctx, "series")) {
    const id = Number(row.id);
    if (!id) { ctx.skip("series", row, "missing id"); continue; }
    if (!may(ctx, "series")) { ctx.skip("series", row, NO_ACCESS); continue; }
    const name = typeof row.name === "string" ? row.name : "";
    const season = Number(row.season !== "" && row.season != null ? row.season : row.year);
    if (!name || !Number.isInteger(season) || season === 0) { ctx.skip("series", row, "Enter a series name and season."); continue; }
    const scoringTableId = await usableScoringTableId(ctx, row.scoring_table_id);
    if (scoringTableId === undefined) { ctx.skip("series", row, "That scoring table isn't available to this club."); continue; }
    const classesRaw = parseJson(row.classes);
    const classes = Array.isArray(classesRaw) ? classesRaw.map(String) : [];
    const idsRaw = parseJson(row.event_ids);
    const eventIds = [...new Set((Array.isArray(idsRaw) ? idsRaw : []).map(ctx.mapEventId).filter(n => Number.isInteger(n) && n > 0))];
    const events = eventIds.length === 0 ? [] : await ctx.tx.select({ id: eventsTable.id, clubId: eventsTable.clubId, scoringTableId: eventsTable.scoringTableId })
      .from(eventsTable).where(inArray(eventsTable.id, eventIds)) as Array<{ id: number; clubId: number; scoringTableId: number | null }>;
    const foreign = events.filter(e => e.clubId !== ctx.clubId).map(e => e.id);
    if (foreign.length > 0) { ctx.skip("series", row, `Events ${foreign.join(", ")} don't belong to this club.`); continue; }
    const [existing] = await ctx.tx.select().from(seriesTable).where(and(eq(seriesTable.id, id), eq(seriesTable.clubId, ctx.clubId)));
    // Events must use the series' scoring format (the website's rule when either changes).
    const sameIds = existing && JSON.stringify([...(existing.eventIds ?? [])].sort()) === JSON.stringify([...eventIds].sort());
    if (scoringTableId && existing && !(sameIds && existing.scoringTableId === scoringTableId)) {
      const mismatched = events.filter(e => e.scoringTableId !== scoringTableId).map(e => e.id);
      if (mismatched.length > 0) {
        ctx.skip("series", row, `Events ${mismatched.join(", ")} use a different scoring format than this series. All events in a series must use the same scoring format.`);
        continue;
      }
    }
    if (existing) {
      await ctx.tx.update(seriesTable).set({ name, season, classes, scoringTableId, eventIds }).where(eq(seriesTable.id, id));
      const changed = !sameIds || existing.scoringTableId !== scoringTableId || JSON.stringify(existing.classes) !== JSON.stringify(classes);
      if (changed) ctx.seriesToRecalculate.add(id);
    } else {
      const [made] = await ctx.tx.insert(seriesTable).values({
        ...(await insertId(ctx, seriesTable, id)), ...madeAt(row), clubId: ctx.clubId, name, season, classes, scoringTableId, eventIds,
        pointsSystem: typeof row.points_system === "string" && row.points_system ? row.points_system : "standard",
      }).returning({ id: seriesTable.id });
      remember(ctx, "series", id, made.id);
      if (eventIds.length > 0) ctx.seriesToRecalculate.add(made.id);
    }
    count(ctx, "series");
  }
}

async function pushCompCodeDeletes(ctx: OrgPushContext) {
  for (const id of deletedIds(ctx, "comp_codes")) {
    if (!may(ctx, "discount_codes", "events")) { ctx.skip("comp_codes_deleted", { id }, NO_ACCESS); continue; }
    const removed = await ctx.tx.delete(compCodesTable)
      .where(and(eq(compCodesTable.id, id), eq(compCodesTable.clubId, ctx.clubId))).returning({ id: compCodesTable.id });
    if (removed.length > 0) count(ctx, "comp_codes_deleted");
  }
}

/** True when the rider is this club's: added by it, or entered in one of its events (as the website checks). */
async function riderBelongsToClub(ctx: OrgPushContext, riderId: number): Promise<boolean> {
  const [direct] = await ctx.tx.select({ id: ridersTable.id }).from(ridersTable)
    .where(and(eq(ridersTable.id, riderId), eq(ridersTable.clubId, ctx.clubId))).limit(1);
  if (direct) return true;
  const [reg] = await ctx.tx.select({ id: registrationsTable.id }).from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(eq(registrationsTable.riderId, riderId), eq(eventsTable.clubId, ctx.clubId))).limit(1);
  return !!reg;
}

/**
 * Discount codes: club-wide codes (Discount Codes page), an event's codes and a
 * rider's code. How many times a code was used is counted by the cloud when a
 * rider registers with it; the desktop never registers with a code, so its
 * count is not taken (a use is counted once, here).
 */
async function pushCompCodes(ctx: OrgPushContext) {
  for (const row of rowsOf(ctx, "comp_codes")) {
    const id = Number(row.id);
    if (!id) { ctx.skip("comp_codes", row, "missing id"); continue; }
    if (!may(ctx, "discount_codes", "events")) { ctx.skip("comp_codes", row, NO_ACCESS); continue; }
    const code = typeof row.code === "string" ? row.code.trim().toUpperCase() : "";
    if (!code) { ctx.skip("comp_codes", row, "Enter a code."); continue; }
    const discountType = row.discount_type == null ? "fixed" : String(row.discount_type);
    if (discountType !== "fixed" && discountType !== "percentage") { ctx.skip("comp_codes", row, "Choose a dollar amount or a percentage discount."); continue; }
    const amount = Number(row.amount);
    if (row.amount == null || row.amount === "" || !Number.isFinite(amount) || amount <= 0) { ctx.skip("comp_codes", row, "Enter an amount greater than $0."); continue; }
    if (discountType === "percentage" && amount > 100) { ctx.skip("comp_codes", row, "A percentage discount can't be more than 100%."); continue; }
    const maxUses = Number(row.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_UNLIMITED) { ctx.skip("comp_codes", row, "Enter how many times the code can be used (1 or more), or choose Unlimited."); continue; }
    let expiresAt: Date | null = null;
    if (row.expires_at != null && row.expires_at !== "") {
      expiresAt = new Date(String(row.expires_at));
      if (isNaN(expiresAt.getTime())) { ctx.skip("comp_codes", row, "Enter a valid expiry date."); continue; }
    }
    const catsRaw = parseJson(row.category_ids);
    const categoryIds = [...new Set((Array.isArray(catsRaw) ? catsRaw : []).map(c => mappedId(ctx, "discount_categories", c)))];
    if (categoryIds.some(c => !Number.isInteger(c) || c <= 0)) { ctx.skip("comp_codes", row, "categoryIds must be category ids"); continue; }
    if (categoryIds.length > 0) {
      const owned = await ctx.tx.select({ id: discountCategoriesTable.id }).from(discountCategoriesTable)
        .where(and(inArray(discountCategoriesTable.id, categoryIds), eq(discountCategoriesTable.clubId, ctx.clubId)));
      if (owned.length !== categoryIds.length) { ctx.skip("comp_codes", row, "One or more categories were not found"); continue; }
    }
    let riderId: number | null = null;
    if (row.rider_id != null && row.rider_id !== "") {
      riderId = Number(row.rider_id);
      if (!Number.isInteger(riderId) || riderId <= 0 || !(await riderBelongsToClub(ctx, riderId))) { ctx.skip("comp_codes", row, "Rider not found"); continue; }
    }
    let eventId: number | null = null;
    if (row.event_id != null && row.event_id !== "") {
      eventId = ctx.mapEventId(row.event_id);
      const [ev] = await ctx.tx.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
      if (!ev || ev.clubId !== ctx.clubId) { ctx.skip("comp_codes", row, "event not found for this club"); continue; }
    }
    // What an organizer can change after a code exists (PATCH /discount-codes/:id).
    const editable = { isActive: row.is_active == null ? true : isTrue(row.is_active), discountType: discountType as "fixed" | "percentage", amount: amount.toFixed(2), maxUses, riderId, expiresAt, categoryIds };
    const [byId] = await ctx.tx.select({ id: compCodesTable.id }).from(compCodesTable)
      .where(and(eq(compCodesTable.id, id), eq(compCodesTable.clubId, ctx.clubId)));
    if (byId) {
      await ctx.tx.update(compCodesTable).set(editable).where(eq(compCodesTable.id, id));
    } else {
      // Codes are unique across RM Roost.
      const [byCode] = await ctx.tx.select({ id: compCodesTable.id, clubId: compCodesTable.clubId }).from(compCodesTable).where(eq(compCodesTable.code, code));
      if (byCode && byCode.clubId !== ctx.clubId) { ctx.skip("comp_codes", row, "That code is already in use. Pick a different code."); continue; }
      if (byCode) {
        await ctx.tx.update(compCodesTable).set(editable).where(eq(compCodesTable.id, byCode.id));
        remember(ctx, "comp_codes", id, byCode.id);
      } else {
        const [made] = await ctx.tx.insert(compCodesTable)
          .values({ ...(await insertId(ctx, compCodesTable, id)), ...madeAt(row), clubId: ctx.clubId, eventId, code, usesCount: 0, ...editable })
          .returning({ id: compCodesTable.id });
        remember(ctx, "comp_codes", id, made.id);
      }
    }
    count(ctx, "comp_codes");
  }
}

/** Sell Items (POST/PATCH/DELETE /sell-items). */
async function pushSellItems(ctx: OrgPushContext) {
  for (const id of deletedIds(ctx, "club_sell_items")) {
    if (!may(ctx, "payments")) { ctx.skip("club_sell_items_deleted", { id }, NO_ACCESS); continue; }
    const [item] = await ctx.tx.select({ kind: clubSellItemsTable.kind }).from(clubSellItemsTable)
      .where(and(eq(clubSellItemsTable.id, id), eq(clubSellItemsTable.clubId, ctx.clubId)));
    if (!item) continue; // already removed
    if (item.kind !== "custom") { ctx.skip("club_sell_items_deleted", { id }, "The RM TrackR Transponder and RFID Tag can't be removed. Hide them instead."); continue; }
    await ctx.tx.delete(clubSellItemsTable).where(eq(clubSellItemsTable.id, id));
    count(ctx, "club_sell_items_deleted");
  }
  for (const row of rowsOf(ctx, "club_sell_items")) {
    const id = Number(row.id);
    if (!id) { ctx.skip("club_sell_items", row, "missing id"); continue; }
    if (!may(ctx, "payments")) { ctx.skip("club_sell_items", row, NO_ACCESS); continue; }
    const kind = row.kind === "rm_trackr" || row.kind === "rfid_tag" ? row.kind : "custom";
    const price = parseSellItemPrice(row.price);
    if ("error" in price) { ctx.skip("club_sell_items", row, price.error); continue; }
    if (price.price == null && kind !== "rfid_tag") { ctx.skip("club_sell_items", row, "Enter a price for the item."); continue; }
    const name = parseSellItemName(row.name);
    if (kind === "custom" && "error" in name) { ctx.skip("club_sell_items", row, name.error); continue; }
    const set: Record<string, unknown> = { price: price.price == null ? null : price.price.toFixed(2), hidden: isTrue(row.hidden) };
    let [existing] = await ctx.tx.select({ id: clubSellItemsTable.id, kind: clubSellItemsTable.kind }).from(clubSellItemsTable)
      .where(and(eq(clubSellItemsTable.id, id), eq(clubSellItemsTable.clubId, ctx.clubId)));
    if (!existing && kind !== "custom") {
      // One RM TrackR and one RFID Tag per club: the desktop's row is that item.
      [existing] = await ctx.tx.select({ id: clubSellItemsTable.id, kind: clubSellItemsTable.kind }).from(clubSellItemsTable)
        .where(and(eq(clubSellItemsTable.clubId, ctx.clubId), eq(clubSellItemsTable.kind, kind)));
      if (existing) remember(ctx, "club_sell_items", id, existing.id);
    }
    if (existing) {
      // The built-in items can't be renamed.
      if (existing.kind === "custom" && "name" in name) set.name = name.name;
      await ctx.tx.update(clubSellItemsTable).set(set).where(eq(clubSellItemsTable.id, existing.id));
    } else {
      const [{ last } = { last: 0 }] = await ctx.tx.select({ last: max(clubSellItemsTable.sortOrder) }).from(clubSellItemsTable)
        .where(eq(clubSellItemsTable.clubId, ctx.clubId));
      const builtInName = kind === "rm_trackr" ? "RM TrackR Transponder" : "RFID Tag";
      const [made] = await ctx.tx.insert(clubSellItemsTable).values({
        ...(await insertId(ctx, clubSellItemsTable, id)), ...madeAt(row), clubId: ctx.clubId, kind,
        name: kind === "custom" && "name" in name ? name.name : builtInName,
        sortOrder: kind === "rm_trackr" ? 0 : kind === "rfid_tag" ? 1 : (last ?? 0) + 1, ...set,
      }).returning({ id: clubSellItemsTable.id });
      remember(ctx, "club_sell_items", id, made.id);
    }
    count(ctx, "club_sell_items");
  }
}

/** Rental transponder inventory (POST/PATCH/DELETE /rental-transponders). A unit is its number. */
async function pushRentalTransponders(ctx: OrgPushContext, rentalsOut: (clubId: number, exec: Tx) => Promise<Map<string, { riderName: string; eventName: string }>>) {
  for (const row of rowsOf(ctx, "rental_transponders")) {
    const id = Number(row.id);
    if (!id) { ctx.skip("rental_transponders", row, "missing id"); continue; }
    if (!may(ctx, "events")) { ctx.skip("rental_transponders", row, NO_ACCESS); continue; }
    const number = normalizeActiveTransponderIdentifier(typeof row.transponder_number === "string" ? row.transponder_number : null);
    if (!number) { ctx.skip("rental_transponders", row, "Enter the ID printed on the transponder (up to 9 numbers or letters A–F)."); continue; }
    const label = textOrNull(row.label)?.trim().slice(0, 60) ?? null;
    const notes = textOrNull(row.notes)?.trim().slice(0, 500) ?? null;
    const flags = { missing: isTrue(row.missing), retired: isTrue(row.retired) };
    const [byId] = await ctx.tx.select({ id: rentalTranspondersTable.id }).from(rentalTranspondersTable)
      .where(and(eq(rentalTranspondersTable.id, id), eq(rentalTranspondersTable.clubId, ctx.clubId)));
    if (byId) {
      // The number of a listed unit never changes.
      await ctx.tx.update(rentalTranspondersTable).set({ label, notes, ...flags }).where(eq(rentalTranspondersTable.id, id));
    } else {
      const [byNumber] = await ctx.tx.select({ id: rentalTranspondersTable.id, label: rentalTranspondersTable.label, notes: rentalTranspondersTable.notes })
        .from(rentalTranspondersTable)
        .where(and(eq(rentalTranspondersTable.clubId, ctx.clubId), eq(rentalTranspondersTable.transponderNumber, number)));
      if (byNumber) {
        // Listed on the website too: the same unit. Its name and notes stay unless the desktop set them.
        await ctx.tx.update(rentalTranspondersTable).set({ label: label ?? byNumber.label, notes: notes ?? byNumber.notes, ...flags })
          .where(eq(rentalTranspondersTable.id, byNumber.id));
        remember(ctx, "rental_transponders", id, byNumber.id);
      } else {
        const [made] = await ctx.tx.insert(rentalTranspondersTable)
          .values({ ...(await insertId(ctx, rentalTranspondersTable, id)), ...madeAt(row), clubId: ctx.clubId, transponderNumber: number, label, notes, ...flags })
          .returning({ id: rentalTranspondersTable.id });
        remember(ctx, "rental_transponders", id, made.id);
      }
    }
    count(ctx, "rental_transponders");
  }
  const removals = deletedIds(ctx, "rental_transponders");
  if (removals.length === 0) return;
  const out = await rentalsOut(ctx.clubId, ctx.tx);
  for (const id of removals) {
    if (!may(ctx, "events")) { ctx.skip("rental_transponders_deleted", { id }, NO_ACCESS); continue; }
    const [unit] = await ctx.tx.select().from(rentalTranspondersTable)
      .where(and(eq(rentalTranspondersTable.id, id), eq(rentalTranspondersTable.clubId, ctx.clubId)));
    if (!unit) continue; // already removed
    const current = out.get(unit.transponderNumber);
    if (current) { ctx.skip("rental_transponders_deleted", { id }, `This unit is out with ${current.riderName} (${current.eventName}). Mark it returned first, or retire it instead.`); continue; }
    await ctx.tx.delete(rentalTranspondersTable).where(eq(rentalTranspondersTable.id, id));
    count(ctx, "rental_transponders_deleted");
  }
}
