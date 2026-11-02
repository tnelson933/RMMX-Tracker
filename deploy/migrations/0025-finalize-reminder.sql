-- Reminder email to the club's organizers when an event's results still
-- aren't finalized 12 hours after it ended. Sent once per event.
-- Additive and re-runnable. Matches lib/db/src/schema/events.ts.

ALTER TABLE events ADD COLUMN IF NOT EXISTS finalize_reminder_sent_at timestamptz;
