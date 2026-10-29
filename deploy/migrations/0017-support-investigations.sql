-- Support tickets: the investigation agent's run and the fix it proposes, and
-- the owner's approval of that fix. Additive and re-runnable. Matches
-- lib/db/src/schema/support_tickets.ts.

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS investigation_status text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS investigation_started_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS investigation_finished_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS investigation_report text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS investigation_error text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS investigation_usage jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS proposed_fix jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS fix_status text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS fix_token_hash text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS fix_token_expires_at timestamptz;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS fix_result text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS fix_pr_url text;
