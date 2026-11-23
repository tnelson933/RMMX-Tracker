-- Security fix 2026-11-23: rider accounts must prove they own their email before
-- email-matched rider profiles (riders.email) or email invites
-- (rider_profile_managers.invited_email) give them access. Before this, anyone
-- who knew a rider's registration email could create the account and see the
-- rider's details.
--
-- email_verified_at: when the account proved it owns the email (null = unverified).
-- email_verify_code_hash / _expires_at / _attempts: the pending 6-digit code
-- (hashed), its 15-minute expiry and wrong tries (5 max).
--
-- Backfill (owner decision): every account that exists when the column is first
-- added is marked verified, so families who already have access keep it. The
-- backfill only runs in the same step that adds the column, so re-running this
-- file never verifies accounts created later. Re-runnable.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'rider_accounts' AND column_name = 'email_verified_at'
  ) THEN
    ALTER TABLE rider_accounts ADD COLUMN email_verified_at timestamp;
    UPDATE rider_accounts SET email_verified_at = COALESCE(created_at, now()) WHERE email_verified_at IS NULL;
  END IF;
END $$;

ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS email_verify_code_hash text;
ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS email_verify_expires_at timestamp;
ALTER TABLE rider_accounts ADD COLUMN IF NOT EXISTS email_verify_attempts integer NOT NULL DEFAULT 0;
