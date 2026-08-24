---
name: Expo static build debugging
description: How to diagnose Rider App static-export failures in a multi-artifact workspace.
---

Use a configurable Metro port when reproducing the Rider App static export locally, and preserve the response body from a failed bundle request in the build output.

**Why:** The component preview service can occupy Metro's default port in the shared workspace, and Metro returns actionable resolver diagnostics inside an otherwise generic HTTP 500 response.

**How to apply:** For a failed Rider App export, run it on an unused `METRO_PORT` and use the emitted HTTP diagnostic to correct the unresolved module or asset before investigating deployment settings.