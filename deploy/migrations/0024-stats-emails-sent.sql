-- Race day stats emails ("Send me my race day stats" at registration) go out
-- once per event, when all its results become official. Additive and
-- re-runnable. Matches lib/db/src/schema/events.ts.

ALTER TABLE events ADD COLUMN IF NOT EXISTS stats_emails_sent_at timestamptz;
