-- Owner decision 2026-11-20: built-in tables that are out of date are made
-- correct "moving forward".
--
-- 1. "AMA Style" and "Supercross Style" still had the pre-2024 AMA scale
--    (25, 22, 20, 18, 16, 15 … 20th = 1). AMA Pro Motocross and Supercross
--    have used 25, 22, 20, 18, 17, 16 … 21st = 1 since 2024 (the AMA MX and
--    Supercross presets and lib/overallOrder.ts AMA_POINTS). Updating the table
--    here does not re-score anything: points already stored on results stay as
--    they are; races scored from now on use the new scale.
-- 2. That old scale is the regional enduro / hare scramble scale, so 0044 left
--    out its "Enduro / Hare Scramble" template while "AMA Style" held it. Now
--    that it doesn't, add it (still only when no built-in table has the scale).
--
-- Re-runnable: the update only touches a table still on the old scale.

UPDATE points_tables
   SET points_scale = '[25,22,20,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]'::jsonb,
       description = CASE name
         WHEN 'Supercross Style' THEN replace(description,
           'then continuing down to 1 point for 20th place.',
           '18 for fourth, 17 for fifth, then one point less per place down to 1 point for 21st (the AMA scale since 2024).')
         ELSE description || ' Scale: 25, 22, 20, 18, 17, 16, then one point less per place down to 21st = 1 (the AMA scale since 2024).'
       END
 WHERE is_system_default
   AND scoring_method = 'highest_points'
   AND name IN ('AMA Style', 'Supercross Style')
   AND points_scale = '[25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]'::jsonb;

INSERT INTO points_tables (club_id, name, description, scoring_method, main_event_only, points_scale, is_system_default)
SELECT NULL, 'Enduro / Hare Scramble',
       'The common regional enduro and hare scramble scale (ECEA, WORCS): 25, 22, 20, 18, 16, then one point less per place to 20th = 1. Every race counts.',
       'highest_points', false, '[25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]'::jsonb, true
WHERE NOT EXISTS (
  SELECT 1 FROM points_tables p
   WHERE p.is_system_default
     AND p.scoring_method = 'highest_points'
     AND p.main_event_only = false
     AND p.points_scale = '[25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]'::jsonb
);
