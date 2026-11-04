-- Racer profile (rider app): a short bio, a number-plate colour, and who can see
-- the profile. profile_visibility NULL means "default": private for riders under
-- 18 (from date_of_birth), public otherwise. A parent or profile manager can set
-- 'public' or 'private'. Additive and re-runnable.
-- Matches lib/db/src/schema/riders.ts.

ALTER TABLE riders ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS plate_color text;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS profile_visibility text;
