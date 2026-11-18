-- RM Roost's flat fee per registration paid by card, taken from the club's
-- payment as a Stripe application fee (the rider pays the same price).
-- platform_settings holds the RM Roost-wide fee; clubs.registration_fee_cents
-- overrides it for one club (null = use the RM Roost-wide fee).
-- Starts at no fee: nothing changes until a super admin sets one.
-- Additive and re-runnable. Matches lib/db/src/schema/platform_settings.ts and clubs.ts.

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by integer,
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS registration_fee_cents integer;
