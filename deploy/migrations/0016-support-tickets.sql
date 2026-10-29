-- Problems Rocky escalates to the RM Roost team, approved or declined by the
-- owner. Additive and re-runnable. Matches lib/db/src/schema/support_tickets.ts.

CREATE TABLE IF NOT EXISTS support_tickets (
  id                         serial PRIMARY KEY,
  club_id                    integer REFERENCES clubs(id) ON DELETE SET NULL,
  user_id                    integer REFERENCES users(id) ON DELETE SET NULL,
  event_id                   integer REFERENCES events(id) ON DELETE SET NULL,
  conversation_id            integer,
  summary                    text NOT NULL,
  details                    text NOT NULL,
  urgency                    text NOT NULL DEFAULT 'normal',
  diagnostics                jsonb DEFAULT '[]'::jsonb,
  status                     text NOT NULL DEFAULT 'open',
  approval_token_hash        text,
  approval_token_expires_at  timestamptz,
  decided_at                 timestamptz,
  decided_by_user_id         integer REFERENCES users(id) ON DELETE SET NULL,
  resolution                 text,
  resolved_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, created_at);
CREATE INDEX IF NOT EXISTS support_tickets_club_idx ON support_tickets (club_id, created_at);
