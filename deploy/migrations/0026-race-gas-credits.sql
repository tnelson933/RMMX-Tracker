-- Race Gas: a Rocky Mountain ATV website credit for every rider who races an
-- event. One row per rider per event, sent to the CRM once.
-- Additive and re-runnable. Matches lib/db/src/schema/race_gas_credits.ts.

CREATE TABLE IF NOT EXISTS race_gas_credits (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id),
  rider_id integer NOT NULL REFERENCES riders(id),
  first_name text,
  last_name text,
  street_address text,
  city text,
  state text,
  zip text,
  email text,
  amount numeric(10, 2) NOT NULL DEFAULT 15,
  status text NOT NULL DEFAULT 'ready',
  missing_fields text[],
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS race_gas_credits_event_rider ON race_gas_credits (event_id, rider_id);
CREATE INDEX IF NOT EXISTS race_gas_credits_status_idx ON race_gas_credits (status);

-- Sending settings (one row), set on the RM Roost admin's Race Gas page.
CREATE TABLE IF NOT EXISTS race_gas_settings (
  id integer PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  endpoint_url text,
  api_key text,
  amount numeric(10, 2) NOT NULL DEFAULT 15,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO race_gas_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
