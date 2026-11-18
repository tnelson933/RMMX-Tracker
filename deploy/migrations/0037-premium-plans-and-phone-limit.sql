-- RM Roost Premium plans (still switched off): Individual unlocks Premium for 1
-- rider profile and allows 1 phone signed in; Family ($79.99/year) unlocks up to
-- 4 rider profiles and up to 4 phones. rider_mobile_signouts remembers phones
-- signed out by the phone limit so they can say why.
-- Additive and re-runnable. Matches lib/db/src/schema/rider_accounts.ts and rider_mobile_tokens.ts.

ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS premium_plan text;
ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS premium_rider_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS rider_mobile_signouts (
  token text PRIMARY KEY,
  rider_account_id integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
