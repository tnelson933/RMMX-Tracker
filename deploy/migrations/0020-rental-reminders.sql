-- Transponder rental return reminders: the last push reminder's outcome for
-- each rental (sent, or why not), shown as a check mark or red X on the
-- rental pages. Additive and re-runnable. Matches lib/db/src/schema/registrations.ts.

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rental_reminder_status text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS rental_reminder_at timestamptz;
