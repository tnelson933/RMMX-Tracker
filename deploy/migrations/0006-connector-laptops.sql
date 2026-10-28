-- RM Connect laptop pairing: an organizer shows a short-lived code on Reader
-- Setup, RM Connect trades it for its own laptop key, and no password is
-- stored on the laptop. Additive and re-runnable. Matches
-- lib/db/src/schema/connector_laptops.ts.

CREATE TABLE IF NOT EXISTS connector_pairing_codes (
  id serial PRIMARY KEY,
  club_id integer NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_pairing_codes_code_idx ON connector_pairing_codes (code);

-- token_hash is SHA-256 of the laptop key; the key itself is never stored.
CREATE TABLE IF NOT EXISTS connector_laptops (
  id serial PRIMARY KEY,
  club_id integer NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS connector_laptops_club_idx ON connector_laptops (club_id);
