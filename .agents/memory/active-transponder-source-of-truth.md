---
name: Active transponder source of truth
description: Prevents stale event settings and split registration/check-in state from breaking active transponder workflows.
---

Active-transponder registration requirements must be enforced by the API from the current event row, not blocked by browser-side event state.

**Why:** An organizer changed an event to make transponders optional, but an already-open PWA tab kept executing an older JavaScript bundle and rejected the form before any request reached the API, even though the database and current deployment were correct.

**How to apply:** Let registration submissions reach the API, evaluate the event requirement there for organizer and public flows, and ensure service-worker activation reloads already-open clients onto each new deployment.

Active-transponder assignment must keep the rider/registration identity and the check-in display state synchronized. Check-in reads should also tolerate older rows whose registration number was saved before the check-in row was updated.

**Why:** The assignment API returned success and saved the active number, but the check-in screen still showed “No Transponder” because its own linked fields remained blank.

**How to apply:** Any active assignment path must update all event-scoped views that expose assignment state, and read paths should prefer the saved active registration number when healing legacy inconsistencies.

Active timing hardware must use vendor-neutral naming throughout customer surfaces, code, generated contracts, documentation, tests, and filenames.

**Why:** The product is intended for white-label distribution, so implementation hardware suppliers must not be exposed to customers or downstream operators.

**How to apply:** Use “active transponder,” “active timing reader,” “F2000,” or “PowerTag” where technically needed; include repository-wide content and filename scans in verification.