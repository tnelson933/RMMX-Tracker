import OpenAI from "openai";

// Replit's AI proxy vars are honored for compatibility; off Replit set
// OPENAI_API_KEY (base URL defaults to OpenAI's API). A missing key no longer
// crashes server boot — OpenAI requests fail with an auth error instead.
const apiKey =
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;

export const openai = new OpenAI({
  apiKey: apiKey || "not-configured",
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
});
