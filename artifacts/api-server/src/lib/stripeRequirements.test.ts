import assert from "node:assert/strict";
import test from "node:test";
import { requirementLabel, stripeNeeds } from "./stripeRequirements";

test("Stripe's requirement keys in plain words", () => {
  assert.equal(requirementLabel("individual.id_number"), "Social Security number (full)");
  assert.equal(requirementLabel("external_account"), "Bank account for payouts");
  assert.equal(requirementLabel("individual.verification.document"), "Photo ID");
  assert.equal(requirementLabel("something.new"), "Other details Stripe asks for");
});

test("what's left, de-duplicated; past due first", () => {
  assert.deepEqual(stripeNeeds({ requirements: {
    past_due: ["individual.id_number"],
    currently_due: ["individual.id_number", "external_account"],
    pending_verification: ["individual.address.city", "individual.address.line1"],
  } }), {
    needs: ["Social Security number (full)", "Bank account for payouts"],
    needItems: [
      { label: "Social Security number (full)", hint: "The full SSN of the person setting up the account." },
      { label: "Bank account for payouts", hint: "The routing and account number of the account Stripe pays out to." },
    ],
    verifying: ["Address"],
  });
  assert.deepEqual(stripeNeeds({}), { needs: [], needItems: [], verifying: [] });
});
