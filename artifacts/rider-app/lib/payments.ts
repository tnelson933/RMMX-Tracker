import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

// Card payments inside the app: Stripe's native payment sheet (cards, Google
// Pay; Apple Pay once a merchant ID is set up), in builds from 1.0.23. Older
// builds don't have the native code, so they keep the website registration.

let checked: boolean | null = null;

/** True when this build has Stripe's native SDK. */
export function nativePaymentSheetAvailable(): boolean {
  if (checked !== null) return checked;
  if (Platform.OS === "web") return (checked = false);
  try {
    checked = !!(TurboModuleRegistry.get("StripeSdk") ?? (NativeModules as Record<string, unknown>).StripeSdk);
  } catch {
    checked = false;
  }
  return checked;
}

export interface SheetParams {
  clientSecret: string;
  publishableKey: string;
  /** The club's own Stripe account (direct charges), or null for RM Roost's. */
  stripeAccount: string | null;
  merchantName: string;
  email?: string | null;
  name?: string | null;
  primaryColor?: string;
}

export type SheetResult = { status: "paid" } | { status: "canceled" } | { status: "failed"; message: string };

/** Show Stripe's payment sheet. Only call when nativePaymentSheetAvailable(). */
export async function payWithSheet(p: SheetParams): Promise<SheetResult> {
  // Loaded only here, so builds without the native module never touch it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stripe = require("@stripe/stripe-react-native") as typeof import("@stripe/stripe-react-native");
  await stripe.initStripe({
    publishableKey: p.publishableKey,
    stripeAccountId: p.stripeAccount ?? undefined,
    urlScheme: "rider-app",
  });
  const init = await stripe.initPaymentSheet({
    paymentIntentClientSecret: p.clientSecret,
    merchantDisplayName: p.merchantName || "RM Roost",
    returnURL: "rider-app://stripe-redirect",
    defaultBillingDetails: { email: p.email ?? undefined, name: p.name ?? undefined },
    googlePay: { merchantCountryCode: "US", currencyCode: "USD", testEnv: p.publishableKey.startsWith("pk_test") },
    appearance: p.primaryColor ? { colors: { primary: p.primaryColor } } : undefined,
  });
  if (init.error) return { status: "failed", message: init.error.message || "Couldn't open the payment form." };
  const res = await stripe.presentPaymentSheet();
  if (res.error) {
    return res.error.code === "Canceled"
      ? { status: "canceled" }
      : { status: "failed", message: res.error.message || "The payment didn't go through." };
  }
  return { status: "paid" };
}
