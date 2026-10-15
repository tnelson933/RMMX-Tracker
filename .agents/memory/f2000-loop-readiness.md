---
name: F2000 loop readiness
description: How to determine and recover F2000 active-timing loop readiness.
---

An F2000 TCP connection and a fresh heartbeat do not mean its enabled loops are ready to receive crossings. Treat the reader as ready only after its loop telemetry confirms each enabled loop is working/running.

**Why:** The F2000 protocol has no acknowledgement for a `readerOpen` command, and it can ignore an open request issued while configuration is still being applied. A connector may otherwise report a healthy connection while both loops remain stopped.

**How to apply:** After configuration and whenever a moto, practice, or test starts, request the enabled loops to open. On later device packets, retry at a bounded interval until loop telemetry confirms they are running. Keep crossing tests in an “opening loops” state until then.