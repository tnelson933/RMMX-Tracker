-- Support alerts by text: one-time reply codes (approve or decline a ticket or
-- its fix by replying YES/NO with the code), and which alert numbers were sent
-- the enrollment confirmation or replied STOP. Additive and re-runnable.
-- Matches lib/db/src/schema/support_tickets.ts.

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS approval_sms_code_hash text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS fix_sms_code_hash text;

CREATE TABLE IF NOT EXISTS sms_alert_enrollments (
  phone            text PRIMARY KEY,
  confirmed_at     timestamptz,
  opted_out_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
