---
name: Playwright on Nix
description: How browser tests must launch Chromium in this Replit Nix environment.
---

Use the Nix-provided system Chromium executable for Playwright browser tests instead of Playwright's downloaded browser binary.

**Why:** The downloaded Linux browser cannot load its expected shared libraries in this Nix environment, even after Playwright downloads successfully. The Nix Chromium package carries compatible runtime dependencies.

**How to apply:** Keep Chromium in the Replit Nix packages and pass the result of `command -v chromium` to Playwright's `launchOptions.executablePath`. Override mobile device profiles to use Chromium when they default to another browser engine.