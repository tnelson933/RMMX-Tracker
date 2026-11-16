-- Check-in add-ons (rentals, RM TrackR and RFID tag sales) taken in cash on the
-- offline desktop app are pushed to the cloud when it reconnects. desktop_ref is
-- the desktop's own id for the payment ("<club id>:<uuid>"), so a retried push
-- never records the same payment twice. Null for payments taken on the website.
-- Additive and re-runnable. Matches lib/db/src/schema/addon_payments.ts.

ALTER TABLE addon_payments ADD COLUMN IF NOT EXISTS desktop_ref text;
CREATE UNIQUE INDEX IF NOT EXISTS addon_payments_desktop_ref_idx
  ON addon_payments (desktop_ref) WHERE desktop_ref IS NOT NULL;
