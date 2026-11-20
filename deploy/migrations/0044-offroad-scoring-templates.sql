-- Owner decision 2026-11-20: built-in (system) scoring templates for enduro,
-- hare scramble and cross-country series, next to the motocross/Supercross ones.
-- The three scales off-road series actually use (rulebooks checked 2026-11-20):
--
--   AMA Off-Road National: 30, 25, 21, 18, 16, 15 … 20th = 1
--     AMA National Enduro, AMA National Hare & Hound, GNCC Pro, Rocky Mountain
--     Enduro Circuit (RMEC) year-end points.
--   Enduro / Hare Scramble: 25, 22, 20, 18, 16, 15 … 20th = 1
--     ECEA enduro and hare scramble, WORCS.
--   GNCC Amateur: 20, 19, 18 … 20th = 1
--
-- Every result counts (no main-event-only). A template is added only when no
-- built-in table already has the same scale (an existing "Enduro" template with
-- the 25-22-20 scale stays as it is), so this never duplicates one. Re-runnable.

INSERT INTO points_tables (club_id, name, description, scoring_method, main_event_only, points_scale, is_system_default)
SELECT NULL, v.name, v.description, 'highest_points', false, v.scale::jsonb, true
FROM (VALUES
  ('AMA Off-Road National',
   'The AMA off-road national scale (National Enduro, National Hare & Hound, GNCC Pro, RMEC): 30, 25, 21, 18, 16, then one point less per place to 20th = 1. Every race counts.',
   '[30,25,21,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]'),
  ('Enduro / Hare Scramble',
   'The common regional enduro and hare scramble scale (ECEA, WORCS): 25, 22, 20, 18, 16, then one point less per place to 20th = 1. Every race counts.',
   '[25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]'),
  ('GNCC Amateur',
   'GNCC amateur class points: 20 for the win, then one point less per place to 20th = 1. Every race counts.',
   '[20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]')
) AS v(name, description, scale)
WHERE NOT EXISTS (
  SELECT 1 FROM points_tables p
   WHERE p.is_system_default
     AND p.scoring_method = 'highest_points'
     AND p.main_event_only = false
     AND p.points_scale = v.scale::jsonb
);
