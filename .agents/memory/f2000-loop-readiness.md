---
name: F2000 loop readiness
description: How to determine and recover F2000 active-timing loop readiness.
---

An F2000 TCP connection and a fresh heartbeat do not mean its enabled loops are ready to receive crossings. Treat the reader as ready only after its loop telemetry confirms each enabled loop is working/running.

**Why:** The F2000 protocol has no acknowledgement for a `readerOpen` command, and it can ignore an open request issued while configuration is still being applied. A connector may otherwise report a healthy connection while both loops remain stopped.

**How to apply:** Send channel and power before loop enable/disable, then open readers. Retry `readerOpen` from an owned timer—not only on telemetry—without reapplying RF settings on every attempt, because configuration resets the loops to stopped. Reapply the full configuration only occasionally, leave a retry interval for it to settle, and cancel retries on success, stop, disconnect, or socket replacement.