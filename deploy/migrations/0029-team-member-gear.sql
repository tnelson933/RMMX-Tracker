-- Group races: what each team member chose at registration (their own RM TrackR,
-- a rental, or buying one; and whether they bought an RFID tag), so the team pays
-- per rider and check-in knows who gets what. Additive and re-runnable.
-- Matches lib/db/src/schema/team_members.ts.

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS trackr_choice text;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS rfid_purchased boolean NOT NULL DEFAULT false;
