-- Quick Check-In asks riders to confirm their RM TrackR and RFID sticker numbers.
-- When a rider says they're wrong, they aren't checked in; this records when, so
-- the organizer check-in screen can show "numbers reported wrong" at the booth.
-- Additive and re-runnable. Matches lib/db/src/schema/checkins.ts.

ALTER TABLE checkins ADD COLUMN IF NOT EXISTS numbers_flagged_at timestamp;
