-- Bring a restored Replit production database (snapshot 2026-10-26, PostgreSQL 16)
-- up to the schema the current code expects (claude-handoff @ bdc3a65f).
--
-- Reviewed by diffing the restored copy against a fresh `drizzle-kit push` of the
-- current schema. Use this instead of `drizzle-kit push` on restored data: push would
-- also DROP the runtime `session` table and the events.entry_fee_category_id FK.
--
-- Additive only. Runs in one transaction and is safe to re-run.
--
-- Deliberately NOT applied:
--   conversations.user_id NOT NULL: production has 2 legacy Rocky conversations with
--     no user. New rows always set user_id, so the column stays nullable.
--   rider_accounts.rm_cash_balance default: '0'::numeric vs 0 is the same value.

BEGIN;

ALTER TABLE clubs  ADD COLUMN IF NOT EXISTS timing_ingest_auth text NOT NULL DEFAULT 'off';

ALTER TABLE motos  ADD COLUMN IF NOT EXISTS announcer_time_expired_at   timestamptz;
ALTER TABLE motos  ADD COLUMN IF NOT EXISTS announcer_expiry_leader_lap integer;
ALTER TABLE motos  ADD COLUMN IF NOT EXISTS announcer_last_extra_lap    integer NOT NULL DEFAULT 0;
ALTER TABLE motos  ADD COLUMN IF NOT EXISTS announcer_sequence          integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS lap_crossings_moto_rfid_crossing_idx
  ON lap_crossings USING btree (moto_id, rfid_number, crossing_time);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enduro_checkpoint_arrivals_time_check_id_enduro_time_checks_id_') THEN
    ALTER TABLE enduro_checkpoint_arrivals
      ADD CONSTRAINT enduro_checkpoint_arrivals_time_check_id_enduro_time_checks_id_
      FOREIGN KEY (time_check_id) REFERENCES enduro_time_checks(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offline_rider_identities_club_id_clubs_id_fk') THEN
    ALTER TABLE offline_rider_identities
      ADD CONSTRAINT offline_rider_identities_club_id_clubs_id_fk
      FOREIGN KEY (club_id) REFERENCES clubs(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offline_rider_identities_rider_id_riders_id_fk') THEN
    ALTER TABLE offline_rider_identities
      ADD CONSTRAINT offline_rider_identities_rider_id_riders_id_fk
      FOREIGN KEY (rider_id) REFERENCES riders(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quick_checkin_notifications_rider_account_id_rider_accounts_id_') THEN
    ALTER TABLE quick_checkin_notifications
      ADD CONSTRAINT quick_checkin_notifications_rider_account_id_rider_accounts_id_
      FOREIGN KEY (rider_account_id) REFERENCES rider_accounts(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;
