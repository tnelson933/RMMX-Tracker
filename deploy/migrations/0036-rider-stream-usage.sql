-- Free live-stream time per rider account and event. Once RM Roost Premium is
-- switched on, a free rider can watch 1 hour of each event's stream before
-- Premium is needed. Additive and re-runnable. Matches lib/db/src/schema/rider_accounts.ts.

CREATE TABLE IF NOT EXISTS rider_stream_usage (
  rider_account_id integer NOT NULL REFERENCES rider_accounts(id) ON DELETE CASCADE,
  event_id integer NOT NULL,
  seconds integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (rider_account_id, event_id)
);
