-- Group races: an event whose registrations are teams. Each team member can
-- carry their own RFID tag and/or RM TrackR; every member's reads count toward
-- the team's laps. Add-on payments gain a quantity (a team buys one per member).
-- Additive and re-runnable. Matches lib/db/src/schema/{events,registrations,
-- addon_payments,team_members}.ts.

ALTER TABLE events ADD COLUMN IF NOT EXISTS group_race boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS riders_per_group integer;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS team_name text;
ALTER TABLE addon_payments ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS team_members (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id integer NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  rider_id integer REFERENCES riders(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text,
  rfid_number text,
  trackr_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_members_event_idx ON team_members (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_registration_position_idx ON team_members (registration_id, position);
