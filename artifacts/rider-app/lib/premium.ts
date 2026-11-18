import { Platform } from "react-native";

/**
 * RM Roost Premium in the rider app. In the app it's sold as Apple / Google
 * in-app subscriptions through RevenueCat (the website sells the same plans
 * through Stripe; Premium belongs to the account and works in both). The app logs
 * into RevenueCat with the RM Roost rider account id, buys, then asks the
 * server to sync (the server checks with RevenueCat; it never trusts the app).
 *
 * Plans: Individual $4.99/month or $49.99/year (1 rider, 1 phone) and Family
 * $79.99/year (up to 4 riders, 4 phones). No free trial.
 *
 * Needs EXPO_PUBLIC_REVENUECAT_IOS_KEY / EXPO_PUBLIC_REVENUECAT_ANDROID_KEY
 * (RevenueCat public SDK keys) in the build, and a native build that includes
 * react-native-purchases (not an over-the-air update). Without a key, or on the
 * web, the store isn't loaded and the Premium screen says how to buy instead.
 */

export const PRODUCT_IDS = {
  individualMonthly: "rmroost_premium_monthly",
  individualYearly: "rmroost_premium_yearly",
  familyYearly: "rmroost_family_yearly",
} as const;
export type ProductKey = keyof typeof PRODUCT_IDS;

/** List prices, shown until the store's own (localized) prices load. */
export const LIST_PRICES: Record<ProductKey, string> = {
  individualMonthly: "$4.99/month",
  individualYearly: "$49.99/year",
  familyYearly: "$79.99/year",
};

export interface PremiumSummary {
  enforced: boolean;
  active: boolean;
  until: string | null;
  plan: "individual" | "family" | null;
  /** Where it was bought: "apple" | "google" | "stripe" (website) | "admin". */
  source: string | null;
  riderIds: number[];
  riders: Array<{ id: number; name: string }>;
  riderSlots: number;
  needsRiderChoice: boolean;
  maxPhones: number;
  freeRockyQuestions: number;
  freeRockyWindowHours: number;
}

function apiKey(): string | null {
  const key = Platform.OS === "ios" ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY
    : Platform.OS === "android" ? process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY : undefined;
  return key && key.trim() ? key.trim() : null;
}

/** True when this build can sell Premium (native app with a store key). */
export function storeAvailable(): boolean {
  return Platform.OS !== "web" && apiKey() != null;
}

type PurchasesModule = typeof import("react-native-purchases").default;
let purchasesPromise: Promise<PurchasesModule | null> | null = null;
let configuredFor: string | null = null;

/** The RevenueCat SDK, configured for this account; null when unavailable. */
async function purchasesFor(accountId: number): Promise<PurchasesModule | null> {
  if (!storeAvailable()) return null;
  purchasesPromise ??= import("react-native-purchases").then(m => m.default).catch(() => null);
  const Purchases = await purchasesPromise;
  if (!Purchases) return null;
  const user = String(accountId);
  try {
    if (configuredFor == null) {
      Purchases.configure({ apiKey: apiKey()!, appUserID: user });
      configuredFor = user;
    } else if (configuredFor !== user) {
      await Purchases.logIn(user);
      configuredFor = user;
    }
  } catch {
    // The store library isn't in this app build (it needs a new build, not an update).
    return null;
  }
  return Purchases;
}

/** Forget the store user when the rider signs out. */
export async function storeSignOut(): Promise<void> {
  if (!configuredFor || !purchasesPromise) return;
  const Purchases = await purchasesPromise;
  try { await Purchases?.logOut(); } catch { /* already anonymous */ }
  configuredFor = null;
}

export interface StorePackage {
  key: ProductKey;
  price: string;
  /** The SDK's package object, passed back to buy(). */
  raw: unknown;
}

/** The plans for sale, with the store's prices. Empty when the store isn't available. */
export async function loadPackages(accountId: number): Promise<StorePackage[]> {
  const Purchases = await purchasesFor(accountId);
  if (!Purchases) return [];
  const offerings = await Purchases.getOfferings();
  const pkgs = offerings.current?.availablePackages ?? [];
  const out: StorePackage[] = [];
  for (const [key, id] of Object.entries(PRODUCT_IDS) as Array<[ProductKey, string]>) {
    const pkg = pkgs.find(p => p.product.identifier.split(":")[0] === id);
    if (pkg) out.push({ key, price: pkg.product.priceString, raw: pkg });
  }
  return out;
}

export type BuyResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

export async function buy(accountId: number, pkg: StorePackage): Promise<BuyResult> {
  const Purchases = await purchasesFor(accountId).catch(() => null);
  if (!Purchases) return { ok: false, cancelled: false, message: "Premium can be bought in the RM Roost app on iPhone or Android." };
  try {
    await Purchases.purchasePackage(pkg.raw as Parameters<PurchasesModule["purchasePackage"]>[0]);
    return { ok: true };
  } catch (err) {
    const e = err as { userCancelled?: boolean; message?: string };
    if (e?.userCancelled) return { ok: false, cancelled: true, message: "" };
    return { ok: false, cancelled: false, message: e?.message || "The purchase didn't go through. You haven't been charged; try again." };
  }
}

export async function restore(accountId: number): Promise<BuyResult> {
  const Purchases = await purchasesFor(accountId).catch(() => null);
  if (!Purchases) return { ok: false, cancelled: false, message: "Restore works in the RM Roost app on iPhone or Android." };
  try {
    await Purchases.restorePurchases();
    return { ok: true };
  } catch (err) {
    return { ok: false, cancelled: false, message: (err as Error)?.message || "Couldn't restore purchases. Try again." };
  }
}

/** Where riders manage or cancel their subscription (Apple and Google handle it). */
export function manageSubscriptionsUrl(): string {
  return Platform.OS === "android"
    ? "https://play.google.com/store/account/subscriptions"
    : "https://apps.apple.com/account/subscriptions";
}
