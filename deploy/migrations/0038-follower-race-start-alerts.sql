-- Followers get a push when a rider they follow is about to start a race.
-- race_alerts: per-follow switch (on by default) for those pushes.
-- rider_race_start_notifications: one row per rider per moto once followers
-- were alerted, so the push never goes out twice (restarts, desktop re-syncs).
-- Additive and re-runnable. Matches lib/db/src/schema/rider_social.ts.

ALTER TABLE rider_follows ADD COLUMN IF NOT EXISTS race_alerts boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS rider_race_start_notifications (
  moto_id integer NOT NULL REFERENCES motos(id) ON DELETE CASCADE,
  rider_id integer NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (moto_id, rider_id)
);
