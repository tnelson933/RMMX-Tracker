-- A discount code's discount is now stored per class entry (each entry holds
-- its share; the shares add up to the code's discount). Entries saved before
-- this held the whole discount on every entry of the checkout, which the
-- check-in payment now adds up. Split those into shares once: equal shares,
-- the leftover cents on the first entry.
--
-- Only touches checkouts where every entry carries the same amount (the old
-- format). migrate.mjs records this file as applied, so it runs once; don't
-- run it by hand, since a second run would split the shares again.

WITH g AS (
  SELECT
    id,
    comp_discount,
    count(*) OVER w AS n,
    min(comp_discount) OVER w AS lo,
    max(comp_discount) OVER w AS hi,
    row_number() OVER (PARTITION BY event_id, rider_id, comp_code ORDER BY id) AS rn
  FROM registrations
  WHERE comp_code IS NOT NULL AND comp_discount > 0
  WINDOW w AS (PARTITION BY event_id, rider_id, comp_code)
)
UPDATE registrations r
SET comp_discount =
  floor(g.comp_discount * 100 / g.n) / 100
  + CASE WHEN g.rn = 1 THEN (g.comp_discount * 100 - floor(g.comp_discount * 100 / g.n) * g.n) / 100 ELSE 0 END
FROM g
WHERE r.id = g.id AND g.n > 1 AND g.lo = g.hi;
