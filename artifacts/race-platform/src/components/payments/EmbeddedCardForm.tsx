import { useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Loader2 } from "lucide-react";

/**
 * Stripe Checkout shown inside our page (no new window). The server creates
 * the checkout session with ui_mode "embedded" and hands back its client
 * secret; the page that opened it watches the session and closes when paid.
 */

interface StripeConfig { stripe: Stripe | null; testMode: boolean }
const configs = new Map<string, Promise<StripeConfig>>();

/**
 * Stripe.js with the site's publishable key, loaded once per account: a club
 * on its own Stripe account is charged on it, so the form must load for it.
 */
export function getStripeConfig(stripeAccount?: string | null): Promise<StripeConfig> {
  const key = stripeAccount ?? "";
  if (!configs.has(key)) {
    configs.set(key, fetch("/api/stripe/config")
      .then(r => (r.ok ? r.json() : { publishableKey: null, testMode: false }))
      .then(async (c: { publishableKey: string | null; testMode: boolean }) => ({
        stripe: c.publishableKey ? await loadStripe(c.publishableKey, stripeAccount ? { stripeAccount } : undefined) : null,
        testMode: !!c.testMode,
      }))
      .catch(() => ({ stripe: null, testMode: false })));
  }
  return configs.get(key)!;
}

export function useStripeConfig(stripeAccount?: string | null): StripeConfig | null {
  const [config, setConfig] = useState<StripeConfig | null>(null);
  useEffect(() => { let live = true; setConfig(null); getStripeConfig(stripeAccount).then(c => { if (live) setConfig(c); }); return () => { live = false; }; }, [stripeAccount]);
  return config;
}

export function EmbeddedCardForm({ clientSecret, stripeAccount, onComplete }: { clientSecret: string; stripeAccount?: string | null; onComplete?: () => void }) {
  const config = useStripeConfig(stripeAccount);
  if (!config) {
    return <div className="flex justify-center py-10"><Loader2 className="animate-spin text-muted-foreground" /></div>;
  }
  if (!config.stripe) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        Card payments in this page aren't set up yet. Use the rider's phone option, or ask your site admin to add the Stripe publishable key.
      </p>
    );
  }
  return (
    <div className="w-full rounded-lg overflow-hidden" data-testid="embedded-checkout">
      <EmbeddedCheckoutProvider key={`${stripeAccount ?? ""}:${clientSecret}`} stripe={config.stripe} options={{ clientSecret, onComplete }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
