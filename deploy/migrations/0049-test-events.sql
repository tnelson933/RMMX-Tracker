-- Test events 2026-11-24: an organizer-controlled flag that keeps an event off
-- every public list and search (home, results, upcoming, series pages, the rider
-- app's browse/upcoming lists) while its own club still sees and runs it and a
-- direct link still opens it. Toggle: event settings, "Test event (hidden from
-- the public)".
--
-- On the run that adds the column (only), events whose NAME contains the whole
-- word "test" or "demo" (any case) are marked, the same rule as the JS regex
-- /\b(test|demo)\b/i: "TEST – ENDURO WORKFLOW", "MYLAPS TEST 1", "Demo Enduro",
-- "Demo: Spring Thaw MX" are marked; "Testing Day", "Contest", "[apptest] ..."
-- and "Demolition Derby" are not. Nothing else is marked. Postgres \m / \M are
-- word-start / word-end, matching \b on letters, digits and underscore.
--
-- Re-runnable: once the column exists the marking is skipped, so an organizer
-- who unticks a name-matched event is never overridden by a later run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'is_test'
  ) THEN
    ALTER TABLE events ADD COLUMN is_test boolean NOT NULL DEFAULT false;
    UPDATE events SET is_test = true WHERE name ~* '\m(test|demo)\M';
  END IF;
END $$;
