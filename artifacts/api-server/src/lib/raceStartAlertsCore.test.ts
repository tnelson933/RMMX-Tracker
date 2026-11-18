import assert from "node:assert/strict";
import test from "node:test";
import type { PushMessage, PushSendResult } from "./push";
import {
  alertFollowersForMoto, isFresh, lineupRiderIds, nextUpMotoIds, raceStartTitle, RACE_ALERT_FRESH_MS,
  type RaceStartDeps, type RaceStartMotoInfo,
} from "./raceStartAlertsCore";

/** In-memory deps: rider 1 (Sam Lee) and rider 2 (Ava Cruz) race moto 10 of event 5. */
function fakeDeps(over: Partial<RaceStartDeps> & { moto?: Partial<RaceStartMotoInfo>; failSend?: "retryable" | "permanent" } = {}) {
  const claims = new Set<string>();
  const sent: PushMessage[][] = [];
  const moto: RaceStartMotoInfo = {
    motoId: 10, eventId: 5, clubId: 1000, motoName: "250 B Moto 1", eventName: "Spring Opener",
    type: "heat", status: "scheduled",
    entrants: [{ riderId: 1, name: "Sam Lee" }, { riderId: 2, name: "Ava Cruz" }],
    ...over.moto,
  };
  const deps: RaceStartDeps = {
    loadMoto: async id => (id === moto.motoId ? moto : null),
    // Account 100 follows both; 200 follows Sam; 300 is Sam's own (parent) account and follows him.
    followers: async ids => [
      { accountId: 100, riderId: 1 }, { accountId: 100, riderId: 2 },
      { accountId: 200, riderId: 1 }, { accountId: 300, riderId: 1 },
    ].filter(f => ids.includes(f.riderId)),
    ownAccounts: async ids => new Map(ids.map(id => [id, id === 1 ? [300] : []])),
    clubOptOuts: async () => new Set(),
    tokens: async ids => [
      { accountId: 100, token: "ExponentPushToken[a]" }, { accountId: 200, token: "ExponentPushToken[b]" },
      { accountId: 300, token: "ExponentPushToken[c]" },
    ].filter(t => ids.includes(t.accountId)),
    isStreaming: () => false,
    claim: async (motoId, riderIds) => riderIds.filter(r => {
      const key = `${motoId}:${r}`;
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    }),
    release: async (motoId, riderIds) => { for (const r of riderIds) claims.delete(`${motoId}:${r}`); },
    send: async (messages): Promise<PushSendResult> => {
      sent.push(messages);
      const ok = !over.failSend;
      const results = messages.map(m => ({ to: m.to, ok, retryable: over.failSend === "retryable" }));
      return { ok, accepted: ok ? messages.length : 0, failed: ok ? 0 : messages.length, results };
    },
    ...over,
  };
  return { deps, sent, claims };
}

test("followers get '<name> is about to start their race' with a tap payload", async () => {
  const { deps, sent } = fakeDeps();
  const out = await alertFollowersForMoto(10, deps);
  assert.deepEqual(out.riderIds.sort(), [1, 2]);
  assert.equal(sent.length, 1);
  const byToken = new Map(sent[0].map(m => [m.to, m]));
  assert.equal(byToken.get("ExponentPushToken[b]")?.title, "Sam Lee is about to start their race");
  assert.equal(byToken.get("ExponentPushToken[a]")?.title, "Sam Lee and Ava Cruz are about to start their race");
  assert.deepEqual(byToken.get("ExponentPushToken[b]")?.data, { type: "follow-race-start", eventId: 5, motoId: 10, riderId: 1, streaming: false });
  assert.match(byToken.get("ExponentPushToken[b]")!.body, /250 B Moto 1 at Spring Opener\. Tap for live results\./);
});

test("the rider's own account isn't told about themselves", async () => {
  const { deps, sent } = fakeDeps();
  await alertFollowersForMoto(10, deps);
  assert.ok(!sent[0].some(m => m.to === "ExponentPushToken[c]"));
});

test("once per rider per moto: up next, then started, then a desktop re-sync sends one push", async () => {
  const { deps, sent } = fakeDeps();
  await alertFollowersForMoto(10, deps);
  const second = await alertFollowersForMoto(10, deps);
  const third = await alertFollowersForMoto(10, { ...deps, loadMoto: async () => ({ ...(await deps.loadMoto(10))!, status: "in_progress" }) });
  assert.equal(sent.length, 1);
  assert.deepEqual(second.riderIds, []);
  assert.deepEqual(third.messages, []);
});

test("concurrent triggers for the same moto send once", async () => {
  const { deps, sent } = fakeDeps();
  await Promise.all([alertFollowersForMoto(10, deps), alertFollowersForMoto(10, deps), alertFollowersForMoto(10, deps)]);
  assert.equal(sent.length, 1);
});

test("the same rider in a different moto is alerted again", async () => {
  const { deps, sent } = fakeDeps();
  await alertFollowersForMoto(10, deps);
  const other = fakeDeps({ moto: { motoId: 11 } }).deps;
  await alertFollowersForMoto(11, { ...other, claim: deps.claim, send: deps.send });
  assert.equal(sent.length, 2);
});

test("a rider added to the lineup after the first alert still gets their own single alert", async () => {
  const first = fakeDeps({ moto: { entrants: [{ riderId: 1, name: "Sam Lee" }] } });
  await alertFollowersForMoto(10, first.deps);
  const later = await alertFollowersForMoto(10, { ...first.deps, loadMoto: fakeDeps().deps.loadMoto });
  assert.deepEqual(later.riderIds, [2]);
  assert.equal(later.messages.length, 1);
  assert.equal(later.messages[0].title, "Ava Cruz is about to start their race");
});

test("a retryable total failure releases the claim so the start can retry; a permanent one doesn't", async () => {
  const retry = fakeDeps({ failSend: "retryable" });
  await alertFollowersForMoto(10, retry.deps);
  assert.equal(retry.claims.size, 0);
  const perm = fakeDeps({ failSend: "permanent" });
  await alertFollowersForMoto(10, perm.deps);
  assert.equal(perm.claims.size, 2);
});

test("no alert for practice, finished races, race alerts off or club notifications off", async () => {
  for (const moto of [{ type: "practice" }, { type: "enduro_test" }, { status: "completed" }, { status: "cancelled" }]) {
    const { deps, sent } = fakeDeps({ moto });
    await alertFollowersForMoto(10, deps);
    assert.equal(sent.length, 0, JSON.stringify(moto));
  }
  const off = fakeDeps({ followers: async () => [] });
  await alertFollowersForMoto(10, off.deps);
  assert.equal(off.sent.length, 0);
  const optOut = fakeDeps({ clubOptOuts: async () => new Set([100, 200]) });
  await alertFollowersForMoto(10, optOut.deps);
  assert.equal(optOut.sent.length, 0);
  assert.equal(optOut.claims.size, 0, "nothing claimed when nobody can be told");
});

test("streaming events say tap to watch live", async () => {
  const { deps, sent } = fakeDeps({ isStreaming: () => true });
  await alertFollowersForMoto(10, deps);
  assert.match(sent[0][0].body, /Tap to watch it live\./);
  assert.equal(sent[0][0].data?.streaming, true);
});

test("lineup rider ids: cloud objects, desktop numbers, skips not-checked-in slots", () => {
  assert.deepEqual(lineupRiderIds([{ riderId: 3 }, { riderId: 4, checkedIn: false }, { riderId: 5, checkedIn: true }]), [3, 5]);
  assert.deepEqual(lineupRiderIds([7, 8, 7, 0]), [7, 8]);
  assert.deepEqual(lineupRiderIds(null), []);
});

test("next up: lowest scheduled race, skipping practice, with its staggered partner", () => {
  const m = (id: number, motoNumber: number, over: Partial<{ type: string; status: string; staggeredWithMotoId: number | null; staggeredGroupId: number | null }> = {}) =>
    ({ id, motoNumber, type: "heat", status: "scheduled", staggeredWithMotoId: null, staggeredGroupId: null, ...over });
  assert.deepEqual(nextUpMotoIds([m(1, 1, { status: "completed" }), m(2, 2, { type: "practice" }), m(4, 4), m(3, 3)]), [3]);
  assert.deepEqual(nextUpMotoIds([m(3, 3, { staggeredGroupId: 9 }), m(5, 5, { staggeredGroupId: 9 }), m(4, 4)]), [3, 5]);
  assert.deepEqual(nextUpMotoIds([m(6, 6, { staggeredWithMotoId: 3 }), m(3, 3)]), [3, 6]);
  assert.deepEqual(nextUpMotoIds([]), []);
});

test("freshness window keeps late desktop syncs from alerting", () => {
  const now = Date.now();
  assert.equal(isFresh(new Date(now - 60_000), now), true);
  assert.equal(isFresh(new Date(now - RACE_ALERT_FRESH_MS - 1), now), false);
  assert.equal(isFresh(null, now), false);
  assert.equal(raceStartTitle(["A", "B", "C"]), "A, B and C are about to start their race");
});
