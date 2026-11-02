/**
 * What Stripe still needs from a club's account, in words an organizer can act
 * on (Payments page). Stripe's requirement keys look like
 * "individual.id_number" or "external_account".
 */

const LABELS: Array<[RegExp, string]> = [
  [/^external_account$/, "Bank account for payouts"],
  [/^tos_acceptance\./, "Accept Stripe's terms of service"],
  [/^business_profile\.(url|product_description)$/, "Business website or description"],
  [/^business_profile\.mcc$/, "Business category"],
  [/^business_profile\.name$/, "Business name"],
  [/^business_type$/, "Business type"],
  [/\.id_number$/, "Social Security number (full)"],
  [/\.ssn_last_4$/, "Last 4 digits of Social Security number"],
  [/\.verification\.(additional_)?document$/, "Photo ID"],
  [/\.dob\./, "Date of birth"],
  [/\.address\./, "Address"],
  [/\.(first_name|last_name)$/, "Legal name"],
  [/\.(email)$/, "Email"],
  [/\.(phone)$/, "Phone number"],
  [/^company\.tax_id$/, "Business tax ID (EIN)"],
  [/^company\.name$/, "Legal business name"],
  [/^representative\./, "Account representative's details"],
  [/^(owners|directors|executives)\./, "Owners' and directors' details"],
];

/** What Stripe's form will ask for, so the organizer has it ready. */
const HINTS: Record<string, string> = {
  "Bank account for payouts": "The routing and account number of the account Stripe pays out to.",
  "Accept Stripe's terms of service": "Read and accept Stripe's terms (one checkbox).",
  "Business website or description": "Your club's website, or a sentence about what you sell (e.g. race entries).",
  "Business category": "Pick the type of business (e.g. recreational sports clubs).",
  "Business name": "The name riders see on their card statement.",
  "Business type": "Individual, company or non-profit.",
  "Social Security number (full)": "The full SSN of the person setting up the account.",
  "Last 4 digits of Social Security number": "The last 4 digits of that person's SSN.",
  "Photo ID": "A photo of a driver's license, passport or state ID (front and back), taken with your phone or uploaded.",
  "Date of birth": "That person's date of birth.",
  "Address": "Home or business address.",
  "Legal name": "First and last name as on their ID.",
  "Email": "An email address for the account.",
  "Phone number": "A phone number for the account.",
  "Business tax ID (EIN)": "Your club's EIN.",
  "Legal business name": "The name registered with the IRS.",
  "Account representative's details": "Name, contact details and ID for the person who manages the account.",
  "Owners' and directors' details": "Name and details for each owner or director.",
};

export function requirementHint(label: string): string {
  return HINTS[label] ?? "Stripe will show what it needs.";
}

export function requirementLabel(key: string): string {
  for (const [re, label] of LABELS) if (re.test(key)) return label;
  return "Other details Stripe asks for";
}

/** Distinct plain labels, in Stripe's order. */
export function requirementLabels(keys: readonly string[] | null | undefined): string[] {
  return [...new Set((keys ?? []).map(requirementLabel))];
}

export interface StripeNeeds {
  /** Still to fill in (now or past due). */
  needs: string[];
  /** The same, each with what Stripe's form will ask for. */
  needItems: Array<{ label: string; hint: string }>;
  /** Submitted; Stripe is checking them. */
  verifying: string[];
}

export function stripeNeeds(account: { requirements?: { currently_due?: string[] | null; past_due?: string[] | null; pending_verification?: string[] | null } | null }): StripeNeeds {
  const r = account.requirements ?? {};
  const needs = requirementLabels([...(r.past_due ?? []), ...(r.currently_due ?? [])]);
  return {
    needs,
    needItems: needs.map(label => ({ label, hint: requirementHint(label) })),
    verifying: requirementLabels(r.pending_verification ?? []),
  };
}
