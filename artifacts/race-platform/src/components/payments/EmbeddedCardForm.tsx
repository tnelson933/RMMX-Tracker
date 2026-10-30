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
let configPromise: Promise<StripeConfig> | null = null;

/** Stripe.js with the site's publishable key (loaded once). */
export function getStripeConfig(): Promise<StripeConfig> {
  if (!configPromise) {
    configPromise = fetch("/api/stripe/config")
      .then(r => (r.ok ? r.json() : { publishableKey: null, testMode: false }))
      .then(async (c: { publishableKey: string | null; testMode: boolean }) => ({
        stripe: c.publishableKey ? await loadStripe(c.publishableKey) : null,
        testMode: !!c.testMode,
      }))
      .catch(() => ({ stripe: null, testMode: false }));
  }
  return configPromise;
}

export function useStripeConfig(): StripeConfig | null {
  const [config, setConfig] = useState<StripeConfig | null>(null);
  useEffect(() => { let live = true; getStripeConfig().then(c => { if (live) setConfig(c); }); return () => { live = false; }; }, []);
  return config;
}

export function EmbeddedCardForm({ clientSecret, onComplete }: { clientSecret: string; onComplete?: () => void }) {
  const config = useStripeConfig();
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
      <EmbeddedCheckoutProvider key={clientSecret} stripe={config.stripe} options={{ clientSecret, onComplete }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
