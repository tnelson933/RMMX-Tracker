-- What a club sells to riders (Admin → Sell Items): the RM TrackR Transponder
-- and RFID Tag (one each per club) plus custom items. Additive and re-runnable.
-- Matches lib/db/src/schema/sell_items.ts.

CREATE TABLE IF NOT EXISTS club_sell_items (
  id          serial PRIMARY KEY,
  club_id     integer NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'custom',
  name        text NOT NULL,
  price       numeric(10, 2),
  hidden      boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_sell_items_club_idx ON club_sell_items (club_id);
CREATE UNIQUE INDEX IF NOT EXISTS club_sell_items_builtin_uq ON club_sell_items (club_id, kind) WHERE kind <> 'custom';
