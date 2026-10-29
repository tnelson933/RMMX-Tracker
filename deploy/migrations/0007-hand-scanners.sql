-- Hand scanners: cellular or Wi-Fi handheld RFID scanners that send reads
-- straight to RM Roost (no RM Connect). A scanner is a reader with
-- connection = 'hand_scanner'; it pairs with a short code tied to that reader.
-- Additive and re-runnable. Matches lib/db/src/schema/readers.ts and
-- lib/db/src/schema/connector_laptops.ts.

ALTER TABLE readers ADD COLUMN IF NOT EXISTS connection text;
ALTER TABLE connector_pairing_codes
  ADD COLUMN IF NOT EXISTS reader_id integer REFERENCES readers(id) ON DELETE CASCADE;
