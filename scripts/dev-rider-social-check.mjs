#!/usr/bin/env node
// Local check of rider career stats, profile managers and following (LOCAL API only).
//   node scripts/dev-rider-social-check.mjs <riderId-with-results>
// Creates throwaway rider accounts (social-*@local.test) and points the given rider's
// email at the "owner" account in the local DB, so only run against a dev database.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const dbUrl = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "::1"].includes(dbUrl.hostname)) { console.error("Refusing: not a local DB"); process.exit(1); }
const api = "http://127.0.0.1:8080/api";
const riderId = Number(process.argv[2]);
if (!riderId) { console.error("Usage: node scripts/dev-rider-social-check.mjs <riderId>"); process.exit(1); }

const { Client } = createRequire(path.join(root, "lib", "db", "package.json"))("pg");
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const stamp = Date.now();
const emails = { owner: `social-owner-${stamp}@local.test`, manager: `social-manager-${stamp}@local.test`, other: `social-other-${stamp}@local.test` };
const pw = "LocalCheck-" + stamp;
let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`); if (!ok) failures++; };

async function register(email) {
  const r = await fetch(`${api}/rider/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) });
  const j = await r.json();
  if (!j.mobileToken) throw new Error(`register ${email}: ${r.status} ${JSON.stringify(j)}`);
  return j.mobileToken;
}
async function call(token, method, p, body) {
  const r = await fetch(api + p, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

try {
  const [{ email: originalEmail }] = (await db.query("SELECT email FROM riders WHERE id = $1", [riderId])).rows;
  await db.query("UPDATE riders SET email = $1 WHERE id = $2", [emails.owner, riderId]);
  const owner = await register(emails.owner);
  const other = await register(emails.other);

  console.log("\n== #4 career stats");
  const st = await call(owner, "GET", `/rider/profiles/${riderId}/stats`);
  check("owner gets stats", st.status === 200 && st.json?.stats?.starts > 0, JSON.stringify(st.json).slice(0, 200));
  console.log("      ", JSON.stringify(st.json?.stats));
  check("unrelated rider is refused stats", (await call(other, "GET", `/rider/profiles/${riderId}/stats`)).status === 403);

  console.log("\n== #6 managers");
  const inv = await call(owner, "POST", `/rider/profiles/${riderId}/managers`, { email: emails.manager });
  check("owner invites manager before they have an account", inv.status === 201 && inv.json?.joined === false, JSON.stringify(inv.json));
  check("duplicate invite rejected", (await call(owner, "POST", `/rider/profiles/${riderId}/managers`, { email: emails.manager })).status === 409);
  check("non-owner cannot invite", (await call(other, "POST", `/rider/profiles/${riderId}/managers`, { email: "x@local.test" })).status === 403);
  const manager = await register(emails.manager);
  const mp = await call(manager, "GET", "/rider/profiles");
  check("manager sees the profile in their list", mp.status === 200 && JSON.stringify(mp.json).includes(`"id":${riderId}`), JSON.stringify(mp.json).slice(0, 150));
  check("manager can open race history", (await call(manager, "GET", `/rider/profiles/${riderId}/history`)).status === 200);
  check("manager can open stats", (await call(manager, "GET", `/rider/profiles/${riderId}/stats`)).status === 200);
  check("manager cannot invite others", (await call(manager, "POST", `/rider/profiles/${riderId}/managers`, { email: "y@local.test" })).status === 403);
  const list = await call(manager, "GET", `/rider/profiles/${riderId}/managers`);
  check("manager listed as joined", list.json?.managers?.[0]?.joined === true && list.json?.isOwner === false, JSON.stringify(list.json));
  check("unrelated rider still refused history", (await call(other, "GET", `/rider/profiles/${riderId}/history`)).status === 403);
  const mid = list.json?.managers?.[0]?.id;
  check("manager can remove themself", (await call(manager, "DELETE", `/rider/profiles/${riderId}/managers/${mid}`)).status === 200);
  check("removed manager loses access", (await call(manager, "GET", `/rider/profiles/${riderId}/history`)).status === 403);
  check("owner still has access", (await call(owner, "GET", `/rider/profiles/${riderId}/history`)).status === 200);

  console.log("\n== #5 following");
  const [{ first_name }] = (await db.query("SELECT first_name FROM riders WHERE id = $1", [riderId])).rows;
  const search = await call(other, "GET", `/rider/riders/search?q=${encodeURIComponent(first_name)}`);
  check("search finds the rider by name", search.status === 200 && search.json?.riders?.some(r => r.id === riderId), JSON.stringify(search.json).slice(0, 200));
  check("search hides email/phone", !JSON.stringify(search.json).includes("@"));
  const pub = await call(other, "GET", `/rider/riders/${riderId}/public`);
  check("public profile has published stats", pub.status === 200 && pub.json?.stats?.starts > 0 && pub.json?.following === false, JSON.stringify(pub.json).slice(0, 200));
  check("public profile hides contact details", !/@|phone|dateOfBirth/i.test(JSON.stringify(pub.json)));
  check("follow", (await call(other, "POST", `/rider/follows/${riderId}`)).status === 201);
  check("follow twice is harmless", (await call(other, "POST", `/rider/follows/${riderId}`)).status === 201);
  const fl = await call(other, "GET", "/rider/follows");
  check("following list has the rider", fl.json?.following?.length === 1 && fl.json.following[0].riderId === riderId, JSON.stringify(fl.json));
  const feed = await call(other, "GET", "/rider/feed");
  check("feed shows followed rider's results", feed.json?.items?.some(i => i.riderId === riderId && i.isMine === false), JSON.stringify(feed.json).slice(0, 200));
  const ownerFeed = await call(owner, "GET", "/rider/feed");
  check("owner feed marks own results as mine", ownerFeed.json?.items?.some(i => i.riderId === riderId && i.isMine === true));
  check("unfollow", (await call(other, "DELETE", `/rider/follows/${riderId}`)).status === 200);
  check("feed empty after unfollow", ((await call(other, "GET", "/rider/feed")).json?.items ?? []).length === 0);
  check("anonymous is refused", (await fetch(`${api}/rider/feed`)).status === 401);

  await db.query("UPDATE riders SET email = $1 WHERE id = $2", [originalEmail, riderId]);
} finally {
  await db.query("DELETE FROM rider_accounts WHERE email LIKE 'social-%@local.test'");
  await db.end();
}
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
