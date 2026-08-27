---
name: Fastest-lap eligibility
description: Defines which recorded laps may participate in fastest- or best-lap comparisons.
---

Lap 1 must remain visible, stored, and included in lap counts and total race time, but it is never eligible for a fastest-lap or best-lap comparison. Eligibility starts at lap 2 for races, practice, enduro passes, analytics, announcements, rankings, personal bests, and gate-seeding tie-breaks.

**Why:** The starting gate is often closer to the finish line than a full course lap, so the first gate-to-line segment is shorter and would incorrectly dominate fastest-lap results.

**How to apply:** For ordered lap-time arrays, calculate minima from `slice(1)`. For records with an explicit lap number, require `lapNumber >= 2`. Do not remove lap 1 from storage, display, lap counts, or total-time calculations.