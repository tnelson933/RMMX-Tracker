-- A club's own rental transponders (the units it hands out at events).
-- Whether a unit is out is worked out from the event rentals (a rental entry
-- with that number not yet returned); this table holds the unit list and the
-- organizer's flags. Additive and re-runnable. Matches lib/db/src/schema/rental-transponders.ts.

CREATE TABLE IF NOT EXISTS rental_transponders (
  id                  serial PRIMARY KEY,
  club_id             integer NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  transponder_number  text NOT NULL,
  label               text,
  missing             boolean NOT NULL DEFAULT false,
  retired             boolean NOT NULL DEFAULT false,
  notes               text,
  created_at          timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rental_transponders_club_number_uq
  ON rental_transponders (club_id, transponder_number);
