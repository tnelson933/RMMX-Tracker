-- Owner decision 2026-11-20: when an event's results are finalized again after a
-- correction, only riders whose results actually changed (their place or a lap
-- time) get a new race day stats email, and only their followers get a new
-- push. This table remembers what each rider's results looked like when the
-- last email / push about them went out (a short fingerprint, not the results).
--
-- kind: 'stats_email' (the rider's own race day stats email) or
--       'follow_push' (the "results are in" push to accounts following them).
-- Re-runnable.

CREATE TABLE IF NOT EXISTS results_notifications (
  id          serial PRIMARY KEY,
  event_id    integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  rider_id    integer NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  fingerprint text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS results_notifications_event_rider_kind_uq
  ON results_notifications (event_id, rider_id, kind);
