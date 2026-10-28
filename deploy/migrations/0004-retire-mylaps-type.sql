-- MyLaps/AMB decoders are no longer supported; active timing is the F2000.
-- Older rows saved the active-timing type as "mylaps" (already treated as
-- active timing everywhere), so store it under its current name.
-- Re-runnable: rows already converted are left alone.

UPDATE readers SET type = 'active_transponder' WHERE type = 'mylaps';
UPDATE events SET timing_technology = 'active_transponder' WHERE timing_technology = 'mylaps';
