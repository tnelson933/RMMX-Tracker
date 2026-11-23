-- Race-day speed 2026-11-23: indexes for the columns the hot queries filter on.
-- Until now race_results, motos, registrations and events had only primary keys,
-- so every crossing's leaderboard rebuild (routes/timing.ts buildLeaderboard,
-- filtered by moto_id) and every rider profile/feed (filtered by rider_id)
-- scanned every result ever recorded. Measured locally on 250k rows: 44 ms ->
-- 0.12 ms by moto, 36 ms -> 0.23 ms by rider.
--
-- Plain CREATE INDEX (migrations run in a transaction, so not CONCURRENTLY):
-- the tables are small enough that the brief write lock is a fraction of a
-- second. Deploy outside race hours. Re-runnable.

CREATE INDEX IF NOT EXISTS race_results_moto_idx ON race_results (moto_id);
CREATE INDEX IF NOT EXISTS race_results_rider_idx ON race_results (rider_id);
CREATE INDEX IF NOT EXISTS race_results_event_idx ON race_results (event_id);
CREATE INDEX IF NOT EXISTS motos_event_idx ON motos (event_id, moto_number);
CREATE INDEX IF NOT EXISTS registrations_event_idx ON registrations (event_id);
CREATE INDEX IF NOT EXISTS registrations_rider_idx ON registrations (rider_id);
CREATE INDEX IF NOT EXISTS events_club_date_idx ON events (club_id, date);
CREATE INDEX IF NOT EXISTS lap_crossings_event_idx ON lap_crossings (event_id);
