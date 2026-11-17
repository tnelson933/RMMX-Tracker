// Web build of lib/payments.ts. Stripe's payment sheet is native only, so the
// browser build (used for development and testing) never loads that SDK: the
// registration screen then falls back to the website checkout, as older phone
// builds without the native module do.

export function nativePaymentSheetAvailable(): boolean {
  return false;
}

export interface SheetParams {
  clientSecret: string;
  publishableKey: string;
  stripeAccount: string | null;
  merchantName: string;
  email?: string | null;
  name?: string | null;
  primaryColor?: string;
}

export type SheetResult = { status: "paid" } | { status: "canceled" } | { status: "failed"; message: string };

export async function payWithSheet(_p: SheetParams): Promise<SheetResult> {
  return { status: "failed", message: "Card payment in the app isn't available in a browser." };
}
