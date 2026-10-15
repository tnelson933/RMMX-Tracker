---
name: EAS monorepo submissions
description: How pre-packaged EAS submit jobs resolve project configuration in a nested Expo app.
---

Pre-packaged EAS `submit` and `testflight` jobs resolve Expo project configuration from the repository root. A job's `defaults.run.working_directory` changes shell-step directories but does not change where EAS CLI's internal submission step looks for `app.json` and `eas.json`.

**Why:** In this pnpm monorepo, a valid nested Rider App config still produced “EAS project not configured” during `submit:internal`. The submission reached Apple only after an `after_checkout` hook created a minimal, temporary root `app.json` with the existing project ID and copied the nested `eas.json` to the runner root.

**How to apply:** For reusable EAS submission workflows, pin compatible Node/pnpm versions under workflow `defaults.tools`, and use an `after_checkout` hook to expose non-secret nested app configuration at the ephemeral runner root. Never copy credentials or secrets into committed config.