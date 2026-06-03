---
name: Anthropic AI integration pattern
description: How to call Anthropic claude via Replit AI Integrations proxy in Express routes; key gotchas.
---

## Setup
Call `setupReplitAIIntegrations({ providerSlug: "anthropic", providerUrlEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_BASE_URL", providerApiKeyEnvVarName: "AI_INTEGRATIONS_ANTHROPIC_API_KEY" })` from code_execution sandbox to provision env vars automatically. No manual API key needed.

## Calling the API (no SDK needed)
Use native fetch in the Express route:
```ts
const response = await fetch(`${process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL}/v1/messages`, {
  method: "POST",
  headers: {
    "x-api-key": process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1024, system: "...", messages: [...] }),
});
const data = await response.json() as { content: Array<{ type: string; text: string }> };
const text = data.content.find(b => b.type === "text")?.text ?? "";
```

## Critical gotcha: markdown code fences
Claude often wraps JSON responses in markdown code fences (```json ... ```) even when the prompt says not to. Always strip them before JSON.parse:
```ts
const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
const parsed = JSON.parse(clean);
```

**Why:** Without stripping, JSON.parse throws on the backtick characters and every call fails silently.

## Auth in routes
Use inline session check (no shared middleware): `const userId = (req.session as any).userId; if (!userId) { res.status(401).json({error:"Unauthorized"}); return; }`

## Model notes
- `claude-haiku-4-5` is fastest for structured extraction tasks (JSON from natural language)
- Do NOT set temperature/top_p/top_k — deprecated on newer models, returns 400
