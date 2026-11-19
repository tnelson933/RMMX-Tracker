-- Owner decision 2026-11-19: no club is live yet, so every club still on the
-- older Express connection (paid through RM Roost's Stripe account, with RM Roost
-- paying their Stripe fees) is disconnected. Each one reconnects on the Payments
-- page, which now always creates the club's own Standard account (direct
-- charges: the club pays Stripe's fees, RM Roost gets only its Service fee).
--
-- Same fields the Payments page's own Disconnect clears. Clubs already on their
-- own account (stripe_direct_charges = true) are untouched. Re-runnable: a
-- second run finds nothing, since new connections are always direct.
-- The Express accounts themselves stay in RM Roost's Stripe dashboard (Connect →
-- Accounts), where they can be rejected or closed if wanted.

UPDATE clubs
SET stripe_account_id = NULL,
    stripe_onboarding_complete = false,
    stripe_direct_charges = false,
    stripe_pending_account_id = NULL,
    stripe_terminal_location_id = NULL
WHERE stripe_account_id IS NOT NULL
  AND stripe_direct_charges IS NOT TRUE;
