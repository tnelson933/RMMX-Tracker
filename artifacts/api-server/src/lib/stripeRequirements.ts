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
  /** Submitted; Stripe is checking them. */
  verifying: string[];
}

export function stripeNeeds(account: { requirements?: { currently_due?: string[] | null; past_due?: string[] | null; pending_verification?: string[] | null } | null }): StripeNeeds {
  const r = account.requirements ?? {};
  return {
    needs: requirementLabels([...(r.past_due ?? []), ...(r.currently_due ?? [])]),
    verifying: requirementLabels(r.pending_verification ?? []),
  };
}
