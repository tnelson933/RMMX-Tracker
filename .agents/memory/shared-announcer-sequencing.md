---
name: Shared announcer sequencing
description: Durable sequencing and lifecycle rules for reconnect-safe shared race announcements.
---

Keep the shared announcer event sequence durable and monotonic for the lifetime of a moto ID, including when that moto is restarted. Reset per-run lifecycle markers, but never reset the sequence counter.

**Why:** Viewers retain their last accepted sequence through stream reconnects. Reusing lower sequence numbers after an API or moto restart causes valid new announcements to be rejected, while replaying old numbers can duplicate countdown transitions.

**How to apply:** Any new shared-announcer event must claim its lifecycle marker and next sequence atomically. Race resets may clear start, lap, expiry, extra-lap, and finish markers, but must preserve the durable sequence.