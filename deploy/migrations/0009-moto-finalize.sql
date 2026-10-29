-- Results are published moto by moto: an organizer reviews a finished moto on
-- Race Day Management and clicks Finalize Race, which makes that moto's
-- results public. Additive and re-runnable. Matches lib/db/src/schema/motos.ts.

ALTER TABLE motos ADD COLUMN IF NOT EXISTS results_finalized_at timestamptz;

-- Events already published before this change stay public: their finished
-- motos count as finalized from the time the event was published.
UPDATE motos m
SET results_finalized_at = coalesce(p.published_at, now())
FROM event_publication p
WHERE p.event_id = m.event_id
  AND p.published = true
  AND m.status = 'completed'
  AND m.results_finalized_at IS NULL;
