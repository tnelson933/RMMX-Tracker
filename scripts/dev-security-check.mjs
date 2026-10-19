#!/usr/bin/env node
// Security regression check against the LOCAL API (never a remote host).
// Verifies anonymous access is denied, organizers are limited to their own club,
// public pages still get their data, and server-side pricing/formula rules hold.
//
//   node scripts/dev-security-check.mjs <organizerA-email> <organizerB-email> <password> <clubB-eventId>
//
// Organizer A owns club 1000 (events 1-3); organizer B owns another club whose
// event id is passed last. Both use the same local test password.
const api = "http://127.0.0.1:8080/api";
const [emailA, emailB, password, otherEventArg] = process.argv.slice(2);
if (!emailA || !emailB || !password || !otherEventArg) {
  console.error("Usage: node scripts/dev-security-check.mjs <orgA-email> <orgB-email> <password> <clubB-eventId>");
  process.exit(1);
}
const otherEvent = Number(otherEventArg);

async function login(email) {
  const r = await fetch(`${api}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.headers.get("set-cookie").split(";")[0];
}

async function call(method, path, { cookie, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json };
  } finally { clearTimeout(t); }
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
  if (!ok) failures++;
}
const expectStatus = async (name, method, path, expected, opts) => {
  const r = await call(method, path, opts);
  const ok = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
  check(`${name} (${method} ${path}) => ${r.status}`, ok, `expected ${expected}`);
  return r;
};

const orgA = await login(emailA);
const orgB = await login(emailB);

console.log("\n== Anonymous: private data and writes are denied");
for (const p of ["/riders", "/riders/2", "/events/1/registrations", "/events/2/checkins", "/clubs", "/clubs/1000",
  "/dashboard/club/1000", "/reports/event/2", "/rfid", "/series", "/events/1/transponder-rentals", "/clubs/1000/export"]) {
  await expectStatus("anon read blocked", "GET", p, 401);
}
await expectStatus("anon publish blocked", "POST", "/events/2/results/publish", 401, { body: { published: true } });
await expectStatus("anon moto edit blocked", "PATCH", "/motos/1", 401, { body: {} });
await expectStatus("anon event delete blocked", "DELETE", `/events/${otherEvent}`, 401);
await expectStatus("anon mark-paid blocked", "PATCH", "/registrations/1", 401, { body: { paymentStatus: "paid" } });
await expectStatus("anon rider edit blocked", "PATCH", "/riders/2", 401, { body: { email: "x@example.test" } });
await expectStatus("anon results post blocked", "POST", "/events/2/results", 401, { body: {} });
await expectStatus("anon checkins wipe blocked", "DELETE", "/events/2/checkins", 401);
await expectStatus("anon points-table blocked", "POST", "/points-tables", 401, { body: {} });
await expectStatus("anon sync without token blocked", "POST", "/clubs/1000/sync", 401, { body: {} });

console.log("\n== Anonymous: public data still works");
for (const p of ["/healthz", "/events", "/events/2", "/events/2/results", "/events/2/motos", "/series/1/leaderboard",
  "/public/upcoming", "/public/recent-results", "/public/series", "/public/series/1/standings", "/public/events/1/register-info",
  "/video/status/2", "/config/desktop-release", "/public/states"]) {
  await expectStatus("public read ok", "GET", p, 200);
}
await expectStatus("auth/me still 401 not crash", "GET", "/auth/me", 401);
await expectStatus("rider auth/me reachable", "GET", "/rider/auth/me", 401);
await expectStatus("bad sync token reaches handler", "POST", "/clubs/1000/sync", [401, 403], { body: {}, cookie: undefined });

console.log("\n== Rider lookup hides private fields from anonymous callers");
const regs = await call("GET", "/events/1/registrations", { cookie: orgA });
const lookupEmail = (Array.isArray(regs.json) ? regs.json : []).find(r => r.email)?.email;
if (lookupEmail) {
  const anon = await call("GET", `/public/riders/lookup?email=${encodeURIComponent(lookupEmail)}`);
  const r = anon.json?.riders?.[0] ?? {};
  check("anon lookup finds rider", anon.json?.found === true, JSON.stringify(anon.json).slice(0, 120));
  check("anon lookup hides phone/DOB/address/emergency",
    ["phone", "dateOfBirth", "emergencyContact", "emergencyPhone", "streetAddress", "city", "zip"].every(k => !r[k]),
    Object.keys(r).filter(k => r[k]).join(","));
  const org = await call("GET", `/public/riders/lookup?email=${encodeURIComponent(lookupEmail)}`, { cookie: orgA });
  check("organizer lookup still returns full profile", org.json?.found === true);
} else {
  check("event 1 has a registration with an email for the lookup test", false, "none found");
}

console.log("\n== Organizer A is limited to club 1000");
await expectStatus("own riders", "GET", "/riders", 200, { cookie: orgA });
await expectStatus("own registrations", "GET", "/events/1/registrations", 200, { cookie: orgA });
await expectStatus("own dashboard", "GET", "/dashboard/club/1000", 200, { cookie: orgA });
await expectStatus("other club dashboard", "GET", "/dashboard/club/2000", 403, { cookie: orgA });
await expectStatus("other club registrations", "GET", `/events/${otherEvent}/registrations`, 403, { cookie: orgA });
await expectStatus("other club checkins", "GET", `/events/${otherEvent}/checkins`, 403, { cookie: orgA });
await expectStatus("other club publish", "POST", `/events/${otherEvent}/results/publish`, 403, { cookie: orgA, body: { published: false } });
await expectStatus("other club event edit", "PATCH", `/events/${otherEvent}`, 403, { cookie: orgA, body: { name: "hijacked" } });
await expectStatus("other club event delete", "DELETE", `/events/${otherEvent}`, 403, { cookie: orgA });
await expectStatus("other club edit", "PATCH", "/clubs/2000", 403, { cookie: orgA, body: { name: "hijacked" } });
await expectStatus("other club comp codes list", "GET", `/events/${otherEvent}/comp-codes`, 403, { cookie: orgA });
await expectStatus("other club comp code create", "POST", `/events/${otherEvent}/comp-codes`, 403, { cookie: orgA, body: { discountType: "percentage", amount: 100, count: 1 } });
await expectStatus("other club rider discount code", "POST", "/clubs/2000/riders/2/discount-code", 403, { cookie: orgA, body: {} });
await expectStatus("own comp codes list", "GET", "/events/1/comp-codes", 200, { cookie: orgA });
await expectStatus("create club (admin only)", "POST", "/clubs", 403, { cookie: orgA, body: { name: "x", state: "UT", organizerName: "x", organizerEmail: "x@example.test" } });
const clubs = await call("GET", "/clubs", { cookie: orgA });
check("club list shows only own club", Array.isArray(clubs.json) && clubs.json.every(c => c.id === 1000), JSON.stringify(clubs.json?.map?.(c => c.id)));
await expectStatus("public view of other club results still ok", "GET", `/events/${otherEvent}/results`, 200, { cookie: orgA });
await expectStatus("public view of other club event still ok", "GET", `/events/${otherEvent}`, 200, { cookie: orgA });
const ev = await call("GET", `/events/${otherEvent}`, { cookie: orgB });
check("organizer B can read own event", ev.status === 200 && ev.json?.name !== "hijacked", `${ev.status} ${ev.json?.name}`);
await expectStatus("organizer B cannot read club 1000 riders' detail", "GET", "/riders/2", [403, 404], { cookie: orgB });

console.log("\n== Points formulas cannot run code");
await expectStatus("malicious formula rejected", "POST", "/points-tables", 400, { cookie: orgA, body: {
  name: "SecTest evil", scoringMethod: "formula", pointsScale: [], scoringFormula: 'this.constructor.constructor("return process")()' } });
const good = await expectStatus("valid formula accepted", "POST", "/points-tables", [200, 201], { cookie: orgA, body: {
  name: "SecTest formula", scoringMethod: "formula", pointsScale: [], scoringFormula: "position <= 3 ? (26 - position) * 2 : Math.max(0, 26 - position)" } });
if (good.json?.id) await call("DELETE", `/points-tables/${good.json.id}`, { cookie: orgA });

console.log("\n== Add-on prices come from the server");
const reg = await call("POST", "/public/events/1/register", { body: {
  firstName: "Sec", lastName: "Test", email: `sectest+${Date.now()}@example.test`, raceClass: "250 B", selectedClasses: ["250 B"],
  raceClasses: ["250 B"], selectedPurchaseOptions: [{ id: "pit", name: "Pit pass", amount: -9999 }], waiverAcknowledgedAt: new Date().toISOString(),
} });
const regInfo = JSON.stringify(reg.json ?? {}).slice(0, 300);
const free = reg.json && (reg.json.status === "confirmed" || reg.json.needsPayment === false || reg.json.registration?.status === "confirmed");
check(`negative add-on does not make entry free (status ${reg.status})`, reg.status >= 400 || !free, regInfo);
console.log("      register response:", regInfo);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
