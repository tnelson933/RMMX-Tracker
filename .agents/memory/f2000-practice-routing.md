---
name: F2000 practice routing
description: How active-transponder crossings reach practice sessions and resolve riders.
---

F2000 crossings first attempt token-based reader routing for assigned event checkpoints. When there is no active race-day event, the connector must fall back to the facility endpoint so the active practice session can receive the crossing. Practice lookup must match a rider's active transponder identifier as well as RFID sticker identifiers, case-insensitively.

**Why:** A practice session has no event checkpoint assignment. F2000 hexadecimal IDs may arrive with a different letter case than the organizer entered, and treating them as RFID-only values silently drops valid active-transponder scans.

**How to apply:** Preserve checkpoint routing for assigned event readers, but treat the no-active-race-day response as a facility-routing condition. For all active-timing and practice rider resolution, include the legacy-compatible active-transponder field alongside RFID matching.