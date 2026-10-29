-- One check-in row per rider, event and class. A paid registration is confirmed by
-- Stripe's webhook, the rider's redirect and a background check; two of them at the
-- same moment could each see "no check-in yet" and insert one, giving the rider two
-- gate rows. Inserts now use ON CONFLICT DO NOTHING against this index.
--
-- Keyed by class, not just rider: quick check-in, motos and the class-change cascade
-- treat check-ins per (event, rider, class), so a multi-class rider may legitimately
-- have one row per class.
--
-- Existing duplicates are removed first, keeping the most complete row (checked in,
-- then transponder linked, then has a transponder number, then has a bib), and the
-- oldest among equals. Nothing references checkins.id. Re-runnable.
-- Matches lib/db/src/schema/checkins.ts.

DELETE FROM checkins c
USING (
  SELECT id,
         row_number() OVER (
           PARTITION BY event_id, rider_id, race_class
           ORDER BY checked_in DESC,
                    rfid_linked DESC,
                    (rfid_number IS NOT NULL AND rfid_number <> '') DESC,
                    (bib_number IS NOT NULL AND bib_number <> '') DESC,
                    id ASC
         ) AS rn
  FROM checkins
) ranked
WHERE c.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS checkins_event_rider_class_uq
  ON checkins (event_id, rider_id, race_class);
