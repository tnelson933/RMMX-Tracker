---
name: Stripe Connect setup
description: Stripe Connect Express integration for club organizer payout accounts — files, patterns, and gotchas.
---

## What was built
Club organizers can connect a Stripe Express account to collect event entry fees. The feature is club-scoped: `clubs` table has `stripe_account_id` + `stripe_onboarding_complete` columns.

## Key files
- `artifacts/api-server/src/stripeClient.ts` — fetches credentials via Replit connector API; exports `getUncachableStripeClient()` + `getStripeSync()`
- `artifacts/api-server/src/webhookHandlers.ts` — thin wrapper calling `stripeSync.processWebhook()`
- `artifacts/api-server/src/routes/stripe-connect.ts` — GET/POST/DELETE routes for Connect status, start, return, dashboard-link
- `artifacts/race-platform/src/pages/organizer/StripeConnect.tsx` — Payments page in organizer portal
- Sidebar: `OrganizerLayout.tsx` — "Payments" nav item routes to `/payments`
- Event create form: `EventsList.tsx` — collect payments checkbox (greyed + tooltip if stripe not ready)

## Critical patterns
- Webhook route in `app.ts` registered BEFORE `express.raw()` / BEFORE `express.json()` — if you add middleware before the webhook block it will break signature validation.
- `stripeClient.ts` fetches from Replit connector API on every call (not cached) — tokens can rotate.
- `stripe-replit-sync` package + `stripe` both installed at workspace root (`pnpm add -w`), NOT inside any workspace package.
- Stripe connector ID: `connector:ccfg_stripe_01K611P4YQR0SZM11XFRQJC44Y`

**Why:** Replit Stripe integration proxies secret key via connector API; `stripe-replit-sync` handles webhook schema migrations and backfill sync.

## Onboarding flow
1. POST `/api/stripe/connect/start` → creates Express account → returns accountLink URL → frontend redirects user to Stripe
2. After Stripe onboarding, Stripe redirects to GET `/api/stripe/connect/return` → checks `charges_enabled` → sets `stripeOnboardingComplete = true` → redirects to `/payments?connected=1`
3. Frontend `StripeConnect.tsx` detects `?connected=1`, shows success banner, refetches status
