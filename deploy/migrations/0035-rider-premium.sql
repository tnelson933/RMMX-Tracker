-- RM Roost Premium for riders, set up but switched off. Nothing is gated until a
-- super admin turns Premium on (platform_settings key "premium_enforced").
-- rider_accounts.premium_until / premium_source: when Premium is active until and
-- where it came from (billing or an admin). rider_ai_usage: one row per question a
-- rider asks Rocky, for the free allowance (1 per 24 hours) and AI cost tracking.
-- Additive and re-runnable. Matches lib/db/src/schema/rider_accounts.ts.

ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS premium_until timestamp;
ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS premium_source text;

CREATE TABLE IF NOT EXISTS rider_ai_usage (
  id serial PRIMARY KEY,
  rider_account_id integer NOT NULL REFERENCES rider_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rider_ai_usage_account_time_idx ON rider_ai_usage (rider_account_id, created_at);
