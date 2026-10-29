import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { clubsTable } from "./clubs";
import { readersTable } from "./readers";

export const tracksTable = pgTable("tracks", {
  id: serial("id").primaryKey(),
  clubId: integer("club_id").notNull().references(() => clubsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * A track's standard course map: one finish-line reader and ordered split
 * readers. Events at the track get a copy (event_reader_assignments) and
 * practices snapshot it, so it's set up once per track.
 */
export const trackCoursePointsTable = pgTable("track_course_points", {
  id: serial("id").primaryKey(),
  trackId: integer("track_id").notNull().references(() => tracksTable.id, { onDelete: "cascade" }),
  readerId: integer("reader_id").notNull().references(() => readersTable.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["finish", "split"] }).notNull(),
  /** Course order of a split (1 = first after the finish line). */
  sequence: integer("sequence"),
  label: text("label"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [index("track_course_points_track_idx").on(t.trackId)]);

export type TrackCoursePoint = typeof trackCoursePointsTable.$inferSelect;
export type Track = typeof tracksTable.$inferSelect;
export type NewTrack = typeof tracksTable.$inferInsert;