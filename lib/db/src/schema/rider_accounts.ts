import { pgTable, serial, text, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const riderAccountsTable = pgTable("rider_accounts", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  rockyMemory: text("rocky_memory"),
  rmCashBalance: numeric("rm_cash_balance", { precision: 10, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRiderAccountSchema = createInsertSchema(riderAccountsTable).omit({ id: true, createdAt: true });
export type InsertRiderAccount = z.infer<typeof insertRiderAccountSchema>;
export type RiderAccount = typeof riderAccountsTable.$inferSelect;
