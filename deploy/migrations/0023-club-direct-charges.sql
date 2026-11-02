-- Clubs on their own Stripe (Standard) accounts: charges are made directly on
-- the club's account, so RM Roost's account takes no money, fees or losses.
-- Existing Express-connected clubs keep working the old way until they switch
-- (the new account waits in stripe_pending_account_id until it's set up).
-- Additive and re-runnable. Matches lib/db/src/schema/clubs.ts.

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_direct_charges boolean NOT NULL DEFAULT false;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_pending_account_id text;
