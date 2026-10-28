-- Course map: an event's readers laid out along the course.
--   Motocross / supercross: one event-wide "finish" reader (scores laps) plus
--   any number of ordered "split" readers that only produce sector times.
--   Enduro: start/finish readers per special test (unchanged moto-specific rows).
-- Additive and re-runnable. Matches lib/db/src/schema/event_reader_assignments.ts
-- and lib/db/src/schema/split_crossings.ts.

ALTER TABLE event_reader_assignments ADD COLUMN IF NOT EXISTS sequence integer;
ALTER TABLE event_reader_assignments ADD COLUMN IF NOT EXISTS label text;

-- A split read: rider passed split `split_sequence` during lap `lap_number`.
-- assignment_id/reader_id are informational (no FK): assignments are replaced
-- wholesale when the course is saved, and readers can be deleted.
CREATE TABLE IF NOT EXISTS split_crossings (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id),
  moto_id integer NOT NULL REFERENCES motos(id),
  assignment_id integer,
  reader_id integer,
  split_sequence integer NOT NULL,
  label text,
  rider_id integer REFERENCES riders(id),
  rfid_number text NOT NULL,
  lap_number integer NOT NULL,
  crossing_time timestamptz NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- First read of a split per rider per lap wins; repeat reads in the same pass are ignored.
CREATE UNIQUE INDEX IF NOT EXISTS split_crossings_once_per_lap
  ON split_crossings (moto_id, rfid_number, split_sequence, lap_number);
CREATE INDEX IF NOT EXISTS split_crossings_moto_rider_idx ON split_crossings (moto_id, rider_id);
