#!/usr/bin/env node
// Create the first organizer account in an EMPTY dev/test database.
// There is no signup/bootstrap route in the API, so a fresh DB needs one row by hand.
//
//   node scripts/dev-bootstrap-admin.mjs [email] [clubName] [state]
//
// Inserts a club, a super_admin user tied to it (no password), and a one-time
// setup token, then prints the /setup-account link where you choose the password.
// Refuses to run unless DATABASE_URL points at localhost, or at the host named in
// BOOTSTRAP_ALLOW_HOST (the test server's Docker database is "db").
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = new URL(process.env.DATABASE_URL ?? "");
const allowedHosts = ["127.0.0.1", "localhost", "::1", process.env.BOOTSTRAP_ALLOW_HOST].filter(Boolean);
if (!allowedHosts.includes(url.hostname)) {
  console.error(`Refusing: DATABASE_URL host is ${url.hostname}, not localhost.`);
  process.exit(1);
}

const [email = "admin@local.test", clubName = "Dev Club", state = "UT"] = process.argv.slice(2);
const webOrigin = process.env.APP_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? "19869"}`;

const { Client } = createRequire(path.join(root, "lib", "db", "package.json"))("pg");
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rowCount) throw new Error(`User ${email} already exists`);
  const club = await client.query(
    "INSERT INTO clubs (name, state, contact_email) VALUES ($1, $2, $3) RETURNING id",
    [clubName, state, email],
  );
  const user = await client.query(
    "INSERT INTO users (email, name, role, club_id) VALUES ($1, $2, 'super_admin', $3) RETURNING id",
    [email, "Dev Admin", club.rows[0].id],
  );
  const token = randomBytes(32).toString("hex");
  await client.query(
    "INSERT INTO password_setup_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + interval '7 days')",
    [user.rows[0].id, token],
  );
  await client.query("COMMIT");
  console.log(`Created club #${club.rows[0].id} and super_admin ${email}.`);
  console.log(`Set the password here (one-time link): ${webOrigin}/setup-account?token=${token}`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
