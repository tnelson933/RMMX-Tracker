-- Card payments are confirmed from Stripe itself (webhook + a background
-- check), not only when the rider's browser returns from checkout. Each entry
-- remembers its checkout session and what it was charged. Additive and
-- re-runnable. Matches lib/db/src/schema/registrations.ts.

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS stripe_session_id text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS amount_due numeric(10, 2);
CREATE INDEX IF NOT EXISTS registrations_stripe_session_idx ON registrations (stripe_session_id);
