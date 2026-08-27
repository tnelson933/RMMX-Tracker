---
name: Live timing SSE handoff
description: Why live timing stream initialization must be atomic with crossing ingestion.
---

Generate and write the initial leaderboard baseline, then register the SSE subscriber, while holding the same per-moto serialization lock used by crossing ingestion.

**Why:** Subscribing after an asynchronous baseline read creates a lost-event window. Subscribing before it can queue an accepted crossing already represented in the baseline, which leaves stale acknowledgement accounting and can later suppress or duplicate a fallback beep.

**How to apply:** Any change to live timing stream initialization must preserve the atomic choice: a crossing is either historical in the no-sound baseline or delivered after subscription as a live event, never both and never neither.