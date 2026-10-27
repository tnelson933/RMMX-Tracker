-- RM TrackR (active timing transponder) sales: purchased at registration or at
-- check-in, fulfilled when staff assign the rider a transponder.
-- Matches lib/db/src/schema/registrations.ts. Additive and re-runnable.

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rm_trackr_purchased boolean NOT NULL DEFAULT false;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rm_trackr_fulfilled_at timestamp;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rm_trackr_transponder text;
