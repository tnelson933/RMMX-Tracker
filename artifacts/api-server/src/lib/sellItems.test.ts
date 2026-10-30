import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_SELL_ITEMS, checkinSellPrices, eventTrackrPrice, parseSellItemName, parseSellItemPrice } from "./sellItems";

test("prices: dollars and cents from $0 to $100,000; blank clears", () => {
  assert.deepEqual(parseSellItemPrice("25"), { price: 25 });
  assert.deepEqual(parseSellItemPrice(" 12.50 "), { price: 12.5 });
  assert.deepEqual(parseSellItemPrice(0), { price: 0 });
  assert.deepEqual(parseSellItemPrice(""), { price: null });
  assert.deepEqual(parseSellItemPrice(null), { price: null });
  assert.ok("error" in parseSellItemPrice("-1"));
  assert.ok("error" in parseSellItemPrice("100001"));
  assert.ok("error" in parseSellItemPrice("abc"));
  assert.ok("error" in parseSellItemPrice("1.234"));
});

test("names are trimmed and limited to 60 characters", () => {
  assert.deepEqual(parseSellItemName("  Pit   pass "), { name: "Pit pass" });
  assert.ok("error" in parseSellItemName("   "));
  assert.ok("error" in parseSellItemName("x".repeat(61)));
});

test("every club starts with the RM TrackR Transponder and RFID Tag", () => {
  assert.deepEqual(BUILT_IN_SELL_ITEMS.map(b => b.kind), ["rm_trackr", "rfid_tag"]);
  assert.equal(BUILT_IN_SELL_ITEMS[0].price, 40);
  assert.equal(BUILT_IN_SELL_ITEMS[1].price, null);
});

test("check-in prices: the event's own price wins, then the club's unless hidden", () => {
  const club = [
    { kind: "rm_trackr" as const, price: 45, hidden: false },
    { kind: "rfid_tag" as const, price: 10, hidden: false },
  ];
  assert.deepEqual(checkinSellPrices({ purchaseOptions: [], rfidStickerFee: null }, club), { rmTrackr: 45, rfidTag: 10 });
  assert.deepEqual(
    checkinSellPrices({ purchaseOptions: [{ id: "rm-trackr", name: "RM TrackR Transponder", amount: 40 }], rfidStickerFee: "12.00" }, club),
    { rmTrackr: 40, rfidTag: 12 },
  );
  const hidden = club.map(i => ({ ...i, hidden: true }));
  assert.deepEqual(checkinSellPrices({ purchaseOptions: [], rfidStickerFee: null }, hidden), { rmTrackr: null, rfidTag: null });
  assert.deepEqual(checkinSellPrices({ purchaseOptions: [], rfidStickerFee: null }, [{ kind: "rfid_tag", price: null, hidden: false }]), { rmTrackr: null, rfidTag: null });
  assert.equal(eventTrackrPrice(null), null);
});
