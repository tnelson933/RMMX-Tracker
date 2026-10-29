-- Which Quick Check-In requirements an event uses: {paid, timing, waiver, pickup, atTrack}.
-- NULL (and any key left out) means the requirement is on.
-- Additive and re-runnable. Matches lib/db/src/schema/events.ts.

ALTER TABLE events ADD COLUMN IF NOT EXISTS quick_checkin_requirements jsonb;
