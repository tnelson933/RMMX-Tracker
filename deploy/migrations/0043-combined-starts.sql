-- Owner decision 2026-11-20: promoters can line two or more small classes up on
-- one gate and run them together while each class is still scored separately.
-- Each class keeps its own moto; a combined start links them into one start
-- group (the same link staggered starts use: staggered_group_id). This flag
-- says the group leaves the gate together rather than in waves, so screens can
-- label it "Combined start". Re-runnable.

ALTER TABLE motos ADD COLUMN IF NOT EXISTS combined_start boolean NOT NULL DEFAULT false;
