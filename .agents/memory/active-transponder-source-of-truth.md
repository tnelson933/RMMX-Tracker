---
name: Active transponder source of truth
description: Prevents stale event settings and split registration/check-in state from breaking active transponder workflows.
---

Active-transponder registration requirements must be enforced by the API from the current event row, not blocked by a cached browser event object.

**Why:** An organizer changed an event to make transponders optional, but a stale client-side value continued rejecting blank submissions even though the database setting was already false.

**How to apply:** Let registration submissions reach the API, then evaluate the event requirement there for organizer and public flows.

Active-transponder assignment must keep the rider/registration identity and the check-in display state synchronized. Check-in reads should also tolerate older rows whose registration number was saved before the check-in row was updated.

**Why:** The assignment API returned success and saved the active number, but the check-in screen still showed “No Transponder” because its own linked fields remained blank.

**How to apply:** Any active assignment path must update all event-scoped views that expose assignment state, and read paths should prefer the saved active registration number when healing legacy inconsistencies.