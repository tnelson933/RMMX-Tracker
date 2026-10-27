-- Rider profile managers (several accounts per rider) and rider follows.
-- Matches lib/db/src/schema/rider_social.ts. Additive and re-runnable.

CREATE TABLE IF NOT EXISTS rider_profile_managers (
  id serial PRIMARY KEY,
  rider_id integer NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  invited_email text NOT NULL,
  rider_account_id integer REFERENCES rider_accounts(id) ON DELETE CASCADE,
  invited_by_account_id integer REFERENCES rider_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rider_profile_managers_rider_email_uq ON rider_profile_managers (rider_id, invited_email);
CREATE INDEX IF NOT EXISTS rider_profile_managers_email_idx ON rider_profile_managers (invited_email);

CREATE TABLE IF NOT EXISTS rider_follows (
  id serial PRIMARY KEY,
  rider_account_id integer NOT NULL REFERENCES rider_accounts(id) ON DELETE CASCADE,
  rider_id integer NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rider_follows_account_rider_uq ON rider_follows (rider_account_id, rider_id);
CREATE INDEX IF NOT EXISTS rider_follows_rider_idx ON rider_follows (rider_id);
