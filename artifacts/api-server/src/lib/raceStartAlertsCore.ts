// "<Rider> is about to start their race" pushes to the rider's followers.
// Pure logic and the send flow with its data access injected, so the
// once-per-rider-per-moto rule is unit-tested without a database
// (raceStartAlertsCore.test.ts). The database wiring is in raceStartAlerts.ts.

import type { PushMessage, PushSendResult } from "./push";

/** A late desktop sync (laptop was offline) must not alert for a race long gone. */
export const RACE_ALERT_FRESH_MS = 15 * 60 * 1000;

/** Practice and enduro tests aren't "a race" riders line up for together. */
export function isRaceMoto(type: string | null | undefined): boolean {
  return type !== "practice" && type !== "enduro_test";
}

/** Whether a timestamp (moto completed or started) is recent enough to alert on. */
export function isFresh(at: Date | string | null | undefined, now: number): boolean {
  if (at == null) return false;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) && now - t <= RACE_ALERT_FRESH_MS && t - now <= RACE_ALERT_FRESH_MS;
}

/**
 * Rider ids from a moto lineup. The cloud stores `[{ riderId, checkedIn?, ... }]`,
 * the desktop sync stores plain rider ids. Pre-generated slots for riders who
 * haven't checked in yet (`checkedIn: false`) aren't racing.
 */
export function lineupRiderIds(lineup: unknown): number[] {
  if (!Array.isArray(lineup)) return [];
  const ids = new Set<number>();
  for (const entry of lineup) {
    if (typeof entry === "number") { if (Number.isInteger(entry) && entry > 0) ids.add(entry); continue; }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { riderId?: unknown; checkedIn?: unknown };
    if (e.checkedIn === false) continue;
    const id = Number(e.riderId);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

export interface ScheduledMoto {
  id: number;
  type: string;
  status: string;
  motoNumber: number;
  staggeredWithMotoId: number | null;
  staggeredGroupId: number | null;
}

/**
 * The race that goes to the gate next: the lowest-numbered scheduled race
 * (practice skipped), plus any race staggered with it, since those start together.
 */
export function nextUpMotoIds(motos: ScheduledMoto[]): number[] {
  const scheduled = motos.filter(m => m.status === "scheduled" && isRaceMoto(m.type))
    .sort((a, b) => a.motoNumber - b.motoNumber || a.id - b.id);
  const first = scheduled[0];
  if (!first) return [];
  const ids = new Set([first.id]);
  for (const m of scheduled) {
    if (m.id === first.id) continue;
    const sameGroup = first.staggeredGroupId != null && m.staggeredGroupId === first.staggeredGroupId;
    const paired = m.staggeredWithMotoId === first.id || first.staggeredWithMotoId === m.id;
    if (sameGroup || paired) ids.add(m.id);
  }
  return [...ids];
}

/** "Sam Lee", "Sam Lee and Ava Cruz", "Sam Lee, Ava Cruz and Ty Ford". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function raceStartTitle(names: string[]): string {
  return names.length === 1
    ? `${names[0]} is about to start their race`
    : `${joinNames(names)} are about to start their race`;
}

export function raceStartBody(motoName: string, eventName: string, streaming: boolean): string {
  return `${motoName} at ${eventName}. ${streaming ? "Tap to watch it live." : "Tap for live results."}`;
}

export interface RaceStartMotoInfo {
  motoId: number;
  eventId: number;
  clubId: number | null;
  motoName: string;
  eventName: string;
  type: string;
  status: string;
  /** Riders in this race, with their display names. */
  entrants: Array<{ riderId: number; name: string }>;
}

export interface RaceStartDeps {
  loadMoto(motoId: number): Promise<RaceStartMotoInfo | null>;
  /** Accounts following these riders with race alerts on. */
  followers(riderIds: number[]): Promise<Array<{ accountId: number; riderId: number }>>;
  /** Accounts that own or manage each rider (they get their own "You're up next"). */
  ownAccounts(riderIds: number[]): Promise<Map<number, number[]>>;
  /** Accounts that turned off notifications from this club. */
  clubOptOuts(clubId: number, accountIds: number[]): Promise<Set<number>>;
  tokens(accountIds: number[]): Promise<Array<{ accountId: number; token: string }>>;
  isStreaming(eventId: number): boolean;
  /** Atomically record (moto, rider) pairs; returns the riders that weren't recorded before. */
  claim(motoId: number, riderIds: number[]): Promise<number[]>;
  /** Undo claims whose pushes all failed for a retryable reason. */
  release(motoId: number, riderIds: number[]): Promise<void>;
  send(messages: PushMessage[]): Promise<PushSendResult>;
}

export interface RaceStartOutcome {
  motoId: number;
  /** Riders whose followers were alerted by this call. */
  riderIds: number[];
  messages: PushMessage[];
}

/**
 * Alert the followers of every rider in this race, once per rider per moto.
 * Safe to call repeatedly (up next, then started, desktop re-syncs): riders
 * already alerted for this moto are skipped by the atomic claim.
 */
export async function alertFollowersForMoto(motoId: number, deps: RaceStartDeps): Promise<RaceStartOutcome> {
  const none: RaceStartOutcome = { motoId, riderIds: [], messages: [] };
  const info = await deps.loadMoto(motoId);
  if (!info || !isRaceMoto(info.type)) return none;
  if (info.status !== "scheduled" && info.status !== "in_progress") return none;
  const names = new Map(info.entrants.map(e => [e.riderId, e.name]));
  if (names.size === 0) return none;

  let follows = await deps.followers([...names.keys()]);
  if (follows.length === 0) return none;

  // A rider's own/managing accounts already get "You're up next" about themselves.
  const own = await deps.ownAccounts([...new Set(follows.map(f => f.riderId))]);
  follows = follows.filter(f => !(own.get(f.riderId) ?? []).includes(f.accountId));
  if (info.clubId != null && follows.length > 0) {
    const optedOut = await deps.clubOptOuts(info.clubId, [...new Set(follows.map(f => f.accountId))]);
    follows = follows.filter(f => !optedOut.has(f.accountId));
  }
  if (follows.length === 0) return none;

  const tokens = await deps.tokens([...new Set(follows.map(f => f.accountId))]);
  const withDevice = new Set(tokens.map(t => t.accountId));
  follows = follows.filter(f => withDevice.has(f.accountId));
  if (follows.length === 0) return none;

  const claimed = new Set(await deps.claim(motoId, [...new Set(follows.map(f => f.riderId))]));
  if (claimed.size === 0) return none;

  const ridersByAccount = new Map<number, number[]>();
  for (const f of follows) {
    if (!claimed.has(f.riderId)) continue;
    const list = ridersByAccount.get(f.accountId) ?? [];
    if (!list.includes(f.riderId)) list.push(f.riderId);
    ridersByAccount.set(f.accountId, list);
  }

  const streaming = deps.isStreaming(info.eventId);
  const messages: PushMessage[] = [];
  const ridersByMessage: number[][] = [];
  for (const t of tokens) {
    const riderIds = ridersByAccount.get(t.accountId);
    if (!riderIds?.length) continue;
    const riderNames = riderIds.map(id => names.get(id) ?? "A rider you follow");
    messages.push({
      to: t.token,
      title: raceStartTitle(riderNames),
      body: raceStartBody(info.motoName, info.eventName, streaming),
      data: { type: "follow-race-start", eventId: info.eventId, motoId, riderId: riderIds[0], streaming },
    });
    ridersByMessage.push(riderIds);
  }
  if (messages.length === 0) return none;

  const result = await deps.send(messages);
  // A rider counts as alerted once any follower's device accepted the push.
  // Release only riders where nothing was accepted and a retry could help.
  const accepted = new Set<number>();
  const retryable = new Set<number>();
  result.results.forEach((r, i) => {
    for (const id of ridersByMessage[i] ?? []) {
      if (r.ok) accepted.add(id);
      else if (r.retryable) retryable.add(id);
    }
  });
  const release = [...claimed].filter(id => !accepted.has(id) && retryable.has(id));
  if (release.length) await deps.release(motoId, release);

  return { motoId, riderIds: [...claimed].filter(id => !release.includes(id)), messages };
}
