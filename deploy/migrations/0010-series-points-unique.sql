-- One stored series total per rider and class. Two point rebuilds that ran at
-- the same time could insert the rows twice, pushing riders down the rider-app
-- standings. Rebuilds now run in a locked transaction; this removes existing
-- duplicates (keeping the newest row) and prevents new ones. Re-runnable.
-- Matches lib/db/src/schema/series.ts.

DELETE FROM series_points a
USING series_points b
WHERE a.series_id = b.series_id
  AND a.rider_id = b.rider_id
  AND a.race_class = b.race_class
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS series_points_series_rider_class_uq
  ON series_points (series_id, rider_id, race_class);
