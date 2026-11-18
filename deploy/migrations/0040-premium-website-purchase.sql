-- RM Roost Premium can also be bought on the website (a Stripe subscription on
-- RM Roost's own Stripe account). These remember the Stripe customer and
-- subscription for the rider account. Premium is still switched off.
-- Additive and re-runnable. Matches lib/db/src/schema/rider_accounts.ts.

ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS premium_stripe_customer_id text;
ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS premium_stripe_subscription_id text;
