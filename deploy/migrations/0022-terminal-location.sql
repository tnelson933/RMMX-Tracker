-- Stripe Terminal: the location each club's card readers are registered to
-- (created when the club adds its first reader). Additive and re-runnable.
-- Matches lib/db/src/schema/clubs.ts.

ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_terminal_location_id text;
