import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAddonSales } from "./addonPayments";

const reg = (id: number, over: Partial<{ transponderRental: boolean; rmTrackrPurchased: boolean; rfidStickerPurchased: boolean; paymentStatus: string; paymentMethod: string | null }> = {}) => ({
  id, transponderRental: false, rmTrackrPurchased: false, rfidStickerPurchased: false, paymentStatus: "unpaid", paymentMethod: null, ...over,
});
const prices = { transponder_rental: 25, rm_trackr: 40, rfid_sticker: 10 };

test("rentals paid at check-in count by method; unpaid ones are owed", () => {
  const s = summarizeAddonSales({
    registrations: [reg(1, { transponderRental: true }), reg(2, { transponderRental: true }), reg(3, { transponderRental: true })],
    ledger: [
      { registrationId: 1, item: "transponder_rental", method: "cash", amount: 25 },
      { registrationId: 2, item: "transponder_rental", method: "card", amount: 25 },
    ],
    prices,
  });
  assert.deepEqual(s.rentals, { count: 3, cash: { count: 1, total: 25 }, card: { count: 1, total: 25 }, unpaid: 1, collected: 50 });
});

test("add-ons chosen at registration count once the entry is paid, by its method", () => {
  const s = summarizeAddonSales({
    registrations: [
      reg(1, { rmTrackrPurchased: true, paymentStatus: "paid", paymentMethod: null }), // online: card
      reg(2, { rmTrackrPurchased: true, paymentStatus: "paid", paymentMethod: "cash" }), // paid at the gate
      reg(3, { rmTrackrPurchased: true }), // not paid yet
      reg(4, { rmTrackrPurchased: true, paymentStatus: "paid", paymentMethod: "card" }),
    ],
    // Bought at check-in: the ledger wins over the entry's payment.
    ledger: [{ registrationId: 4, item: "rm_trackr", method: "cash", amount: 45 }],
    prices,
  });
  assert.deepEqual(s.rmTrackr, { count: 4, cash: { count: 2, total: 85 }, card: { count: 1, total: 40 }, unpaid: 1, collected: 125 });
  assert.equal(s.rentals.count, 0);
  assert.equal(s.rfidTags.count, 0);
});

test("an item with no price set can't be counted as paid with the entry", () => {
  const s = summarizeAddonSales({
    registrations: [reg(1, { rfidStickerPurchased: true, paymentStatus: "paid", paymentMethod: "card" })],
    ledger: [],
    prices: { ...prices, rfid_sticker: null },
  });
  assert.equal(s.rfidTags.unpaid, 1);
  assert.equal(s.rfidTags.collected, 0);
});
