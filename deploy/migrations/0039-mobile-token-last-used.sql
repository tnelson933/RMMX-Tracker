-- When the rider app last used a sign-in token (updated at most hourly). The
-- phone limit (Premium plans, still switched off) counts only tokens the app
-- has used, so website sign-ins never count as a phone or sign a phone out.
-- Additive and re-runnable. Matches lib/db/src/schema/rider_mobile_tokens.ts.

ALTER TABLE rider_mobile_tokens ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
