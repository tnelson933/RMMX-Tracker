-- Owner request 2026-11-20: a rider can own several transponders (e.g. one
-- RM TrackR per bike) and a read of any of them times the rider.
--
-- rider_transponders holds every number a rider owns: kind 'trackr' (RM TrackR /
-- active transponder) or 'rfid' (sticker). A number belongs to one rider at a
-- time (unique index), stored trimmed and lower-case.
--
-- The single profile fields stay: riders.mylaps_transponder_id and
-- riders.rfid_number are each kind's primary (oldest) number. Two triggers keep
-- them and the list in step, so older rider apps, desktop versions and every
-- existing write of the single fields keep working:
--   * a profile field set/changed/cleared -> the list gains/renames/loses that
--     number (a number another rider owns is never taken from them);
--   * the list changed -> the profile field becomes the oldest number of that
--     kind still listed (or NULL), unless it already names a listed number.
--
-- Backfill: every existing profile number goes into the list. When two profiles
-- carry the same number (it happens with duplicate profiles), the lower rider id
-- keeps it in the list (the old lookups' LIMIT 1 behaved the same way); the
-- other profile keeps its field untouched. Re-runnable.

CREATE TABLE IF NOT EXISTS rider_transponders (
  id serial PRIMARY KEY,
  rider_id integer NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  transponder_number text NOT NULL,
  kind text NOT NULL DEFAULT 'trackr',
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rider_transponders_number_idx ON rider_transponders (transponder_number);
CREATE INDEX IF NOT EXISTS rider_transponders_rider_idx ON rider_transponders (rider_id);

-- A profile field changed from o to n (both already trimmed + lower-case).
CREATE OR REPLACE FUNCTION rider_transponders_replace(r integer, k text, o text, n text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF n <> '' AND o <> '' THEN
    -- Same bike, new number: rename in place (keeps its label) when n is free.
    UPDATE rider_transponders SET transponder_number = n, updated_at = now()
     WHERE rider_id = r AND transponder_number = o
       AND NOT EXISTS (SELECT 1 FROM rider_transponders WHERE transponder_number = n);
  END IF;
  IF n <> '' THEN
    INSERT INTO rider_transponders (rider_id, transponder_number, kind)
    VALUES (r, n, k) ON CONFLICT (transponder_number) DO NOTHING;
  END IF;
  IF o <> '' THEN
    DELETE FROM rider_transponders WHERE rider_id = r AND transponder_number = o;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rider_transponders_from_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o text;
  n text;
BEGIN
  o := CASE WHEN TG_OP = 'UPDATE' THEN lower(btrim(coalesce(OLD.mylaps_transponder_id, ''))) ELSE '' END;
  n := lower(btrim(coalesce(NEW.mylaps_transponder_id, '')));
  IF o <> n THEN PERFORM rider_transponders_replace(NEW.id, 'trackr', o, n); END IF;
  o := CASE WHEN TG_OP = 'UPDATE' THEN lower(btrim(coalesce(OLD.rfid_number, ''))) ELSE '' END;
  n := lower(btrim(coalesce(NEW.rfid_number, '')));
  IF o <> n THEN PERFORM rider_transponders_replace(NEW.id, 'rfid', o, n); END IF;
  RETURN NULL;
END $$;

-- The rider's list of kind k changed: point the profile field at a listed number.
CREATE OR REPLACE FUNCTION rider_transponders_refresh_primary(r integer, k text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  cur text;
  first_number text;
BEGIN
  IF k = 'trackr' THEN
    SELECT mylaps_transponder_id INTO cur FROM riders WHERE id = r;
  ELSE
    SELECT rfid_number INTO cur FROM riders WHERE id = r;
  END IF;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM rider_transponders
              WHERE rider_id = r AND kind = k AND transponder_number = lower(btrim(coalesce(cur, '')))) THEN
    RETURN;
  END IF;
  SELECT transponder_number INTO first_number FROM rider_transponders
   WHERE rider_id = r AND kind = k ORDER BY id LIMIT 1;
  IF cur IS NOT DISTINCT FROM first_number THEN RETURN; END IF;
  IF k = 'trackr' THEN
    UPDATE riders SET mylaps_transponder_id = first_number WHERE id = r;
  ELSE
    UPDATE riders SET rfid_number = first_number WHERE id = r;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rider_transponders_to_profile() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM rider_transponders_refresh_primary(NEW.rider_id, NEW.kind); END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN PERFORM rider_transponders_refresh_primary(OLD.rider_id, OLD.kind); END IF;
  RETURN NULL;
END $$;

-- Backfill (before the triggers exist, so it only copies).
INSERT INTO rider_transponders (rider_id, transponder_number, kind)
SELECT id, lower(btrim(mylaps_transponder_id)), 'trackr'
  FROM riders
 WHERE btrim(coalesce(mylaps_transponder_id, '')) <> ''
 ORDER BY id
ON CONFLICT (transponder_number) DO NOTHING;

INSERT INTO rider_transponders (rider_id, transponder_number, kind)
SELECT id, lower(btrim(rfid_number)), 'rfid'
  FROM riders
 WHERE btrim(coalesce(rfid_number, '')) <> ''
 ORDER BY id
ON CONFLICT (transponder_number) DO NOTHING;

DROP TRIGGER IF EXISTS riders_transponders_sync ON riders;
CREATE TRIGGER riders_transponders_sync
  AFTER INSERT OR UPDATE OF mylaps_transponder_id, rfid_number ON riders
  FOR EACH ROW EXECUTE FUNCTION rider_transponders_from_profile();

DROP TRIGGER IF EXISTS rider_transponders_primary_sync ON rider_transponders;
CREATE TRIGGER rider_transponders_primary_sync
  AFTER INSERT OR UPDATE OR DELETE ON rider_transponders
  FOR EACH ROW EXECUTE FUNCTION rider_transponders_to_profile();
