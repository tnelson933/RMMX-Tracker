import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Timestamps are stored "without time zone" and read back as UTC, so every
// session must run in UTC. Production already does; this keeps a database with
// a different default (e.g. local Postgres on Mountain time) from shifting lap
// times and createdAt values by hours.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("connect", (client) => {
  // Queued ahead of the client's first query.
  client.query("SET TIME ZONE 'UTC'").catch((error) => {
    console.error("Could not set PostgreSQL session time zone to UTC", error);
  });
});
// node-postgres emits an "error" event when an idle pooled connection is
// terminated by the database. Without a listener, Node treats that event as
// unhandled and exits the whole API process. The pool already removes the dead
// client, so keep the process alive and let subsequent queries obtain a fresh
// connection.
pool.on("error", (error) => {
  console.error("Unexpected error on idle PostgreSQL client", error);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
