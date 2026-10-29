-- Course maps live on the track: a track in the Track Library keeps its finish
-- reader and ordered split readers, so races and practices there use them
-- without setting them up each time. Additive and re-runnable.
-- Matches lib/db/src/schema/tracks.ts, events.ts and practice.ts.

CREATE TABLE IF NOT EXISTS track_course_points (
  id          serial PRIMARY KEY,
  track_id    integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  reader_id   integer NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('finish', 'split')),
  sequence    integer,
  label       text,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS track_course_points_track_idx ON track_course_points (track_id);

-- An event links to its library track. course_source: 'track' = the event's
-- course is a copy kept in step with the track; 'custom' = changed for this event.
ALTER TABLE events ADD COLUMN IF NOT EXISTS track_id integer REFERENCES tracks(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS course_source text NOT NULL DEFAULT 'track';

-- Practices link to their track and keep the course they started with.
ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS track_id integer REFERENCES tracks(id) ON DELETE SET NULL;
ALTER TABLE practice_sessions ADD COLUMN IF NOT EXISTS course jsonb;

CREATE TABLE IF NOT EXISTS practice_split_crossings (
  id              serial PRIMARY KEY,
  session_id      integer NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  reader_id       integer,
  split_sequence  integer NOT NULL,
  label           text,
  rider_id        integer REFERENCES riders(id),
  rfid_number     text NOT NULL,
  lap_number      integer NOT NULL,
  crossing_time   timestamptz NOT NULL,
  created_at      timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS practice_split_crossings_once_per_lap
  ON practice_split_crossings (session_id, rfid_number, split_sequence, lap_number);

-- Events that already have their own course map keep it as their own.
UPDATE events e SET course_source = 'custom'
WHERE e.course_source = 'track'
  AND EXISTS (
    SELECT 1 FROM event_reader_assignments a
    WHERE a.event_id = e.id AND a.moto_id IS NULL AND a.role IN ('finish', 'split')
  );

-- Link existing events and practices to library tracks of the same club by name.
UPDATE events e SET track_id = t.id
FROM tracks t
WHERE e.track_id IS NULL AND t.club_id = e.club_id
  AND e.track_name IS NOT NULL AND lower(trim(t.name)) = lower(trim(e.track_name));

UPDATE practice_sessions p SET track_id = t.id
FROM tracks t
WHERE p.track_id IS NULL AND t.club_id = p.club_id
  AND p.venue_name IS NOT NULL AND lower(trim(t.name)) = lower(trim(p.venue_name));
