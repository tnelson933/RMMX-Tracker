---
name: Fastest-lap eligibility
description: Defines which recorded laps may participate in fastest- or best-lap comparisons.
---

Lap 1 is excluded from fastest/best-lap comparisons only when an event's race style is exactly motocross, which also covers supercross formatting. For motocross, lap 1 remains visible, stored, and included in lap counts and total race time. Enduro and cross-country/desert events count lap 1 normally. Unknown or missing race styles include lap 1 rather than discard a potentially valid time.

**Why:** Motocross and supercross begin at a start gate away from the finish loop, making their first recorded interval incomplete. Enduro and cross-country/desert timing models do not share that assumption, so excluding their first interval removes a valid result.

**How to apply:** Use exact `raceStyle === "motocross"` as the only exclusion condition. For qualifying explicit crossings require lap number 2 or greater; for qualifying ordered per-moto arrays exclude the original first element before parsing/filtering. Otherwise include lap 1. Apply independently per moto before event/series aggregation. Never remove lap 1 from lap lists, counts, totals, or cumulative-time calculations.