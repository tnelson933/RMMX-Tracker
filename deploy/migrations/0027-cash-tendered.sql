-- Cash at the gate: what the rider handed over and the change given back,
-- logged with each cash payment (the payment itself stays at the amount due).
-- Additive and re-runnable. Matches lib/db/src/schema/registrations.ts and
-- lib/db/src/schema/addon_payments.ts.

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS cash_tendered numeric(10, 2);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS cash_change numeric(10, 2);
ALTER TABLE addon_payments ADD COLUMN IF NOT EXISTS cash_tendered numeric(10, 2);
ALTER TABLE addon_payments ADD COLUMN IF NOT EXISTS cash_change numeric(10, 2);
