---
name: F2000 practice routing
description: How active-transponder crossings reach practice sessions and resolve riders.
---

Keep Feibot loops armed and forward physical F2000 reads even when RM Connect missed a WebSocket start command. The server is the timing-session authority: an armed connector includes its event ID; a context-free read routes to the actual in-progress moto, otherwise to a running practice, and is rejected while timing is idle. Passive RFID remains connector-gated to a moto or hardware test.

**Why:** Gating F2000 forwarding only on process-local connector state silently loses every crossing after a missed start command, while accepting every always-forward read into any race-day event can accidentally start a scheduled test.

**How to apply:** Preserve event context on armed crossing posts, route context-free active reads only through a live moto or practice, and return a non-fallback error while idle. Resolve event registration active IDs before the global rider active ID, then retain legacy RFID/global fallbacks case-insensitively.