-- Add-ons paid at check-in (transponder rentals, RM TrackR and RFID tag
-- sales): amount, cash or card, paid or pending (card until Stripe confirms).
-- Additive and re-runnable. Matches lib/db/src/schema/addon_payments.ts.

CREATE TABLE IF NOT EXISTS addon_payments (
  id                 serial PRIMARY KEY,
  event_id           integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  registration_id    integer NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  item               text NOT NULL,
  amount             numeric(10, 2) NOT NULL,
  method             text NOT NULL,
  status             text NOT NULL,
  stripe_session_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz
);
CREATE INDEX IF NOT EXISTS addon_payments_event_idx ON addon_payments (event_id);
CREATE INDEX IF NOT EXISTS addon_payments_registration_idx ON addon_payments (registration_id);
CREATE INDEX IF NOT EXISTS addon_payments_session_idx ON addon_payments (stripe_session_id);
