-- Racer profile photos (rider app and rider website): a headshot shown in place
-- of the initials circle, and a background photo shown in place of the stock
-- riding photo. Both hold an /api/storage/uploads/... path. Shown to everyone
-- only when the profile is public (see effectiveVisibility in
-- artifacts/api-server/src/lib/riderResume.ts); otherwise only to the rider's
-- own managers. Additive and re-runnable.
-- Matches lib/db/src/schema/riders.ts.

ALTER TABLE riders ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS cover_url text;
