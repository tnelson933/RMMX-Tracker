import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
