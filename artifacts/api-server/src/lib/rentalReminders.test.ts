import assert from "node:assert/strict";
import test from "node:test";
import { reminderStatusText, rentalReminderText } from "./rentalReminders";

test("the reminder names the replacement charge the organizer set", () => {
  assert.equal(
    rentalReminderText(45),
    "Don't forget to return your rented transponder. Any transponders not returned within 24 hours will be charged $45.00.",
  );
  assert.match(rentalReminderText(null), /charged the cost of the transponder\.$/);
});

test("each outcome has a plain explanation for the check mark or red X", () => {
  assert.equal(reminderStatusText("sent"), "Push notification sent");
  assert.match(reminderStatusText("no_app")!, /doesn't have the RM Roost app/);
  assert.match(reminderStatusText("no_notifications")!, /hasn't turned on notifications/);
  assert.match(reminderStatusText("failed")!, /Try again/);
  assert.equal(reminderStatusText(null), null);
});
