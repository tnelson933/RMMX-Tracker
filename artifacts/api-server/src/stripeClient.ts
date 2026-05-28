import Stripe from "stripe";
import { StripeSync } from "stripe-replit-sync";

async function getCredentials(): Promise<{ publishableKey: string; secretKey: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error("Stripe integration not connected. Add it via the Integrations tab.");
  }

  const isProduction = process.env.REPLIT_DEPLOYMENT === "1";
  const targetEnvironment = isProduction ? "production" : "development";

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set("include_secrets", "true");
  url.searchParams.set("connector_names", "stripe");
  url.searchParams.set("environment", targetEnvironment);

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json", "X-Replit-Token": xReplitToken },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) throw new Error(`Failed to fetch Stripe credentials: ${resp.status}`);

  const data = await resp.json() as { items?: Array<{ settings?: { publishable?: string; secret?: string } }> };
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret) {
    throw new Error("Stripe integration not connected or missing secret key.");
  }

  return {
    publishableKey: settings.publishable ?? "",
    secretKey: settings.secret,
  };
}

/** Returns a fresh authenticated Stripe client. Never cache — tokens can rotate. */
export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getCredentials();
  return new Stripe(secretKey, { apiVersion: "2025-08-27.basil" as any });
}

/** Returns a fresh StripeSync instance. */
export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL required");
  const { secretKey } = await getCredentials();
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
  });
}
