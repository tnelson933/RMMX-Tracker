/** A two-letter US state or territory code (for a Stripe Terminal location address). */
const CODES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split(" "));
export function checkStatesCode(code: string): boolean {
  return CODES.has(code.trim().toUpperCase());
}
