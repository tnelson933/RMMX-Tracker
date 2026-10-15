import Anthropic from "@anthropic-ai/sdk";

// Replit's AI proxy vars are honored for compatibility; off Replit set
// ANTHROPIC_API_KEY (base URL defaults to Anthropic's API). A missing key no
// longer crashes server boot — AI requests fail with an auth error instead.
const apiKey =
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.warn("Anthropic API key not configured; AI features will be unavailable.");
}

export const anthropic = new Anthropic({
  apiKey: apiKey || "not-configured",
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL || undefined,
});
