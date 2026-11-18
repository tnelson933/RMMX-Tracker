/**
 * RM Roost Premium on the rider website (switched off by default, so none of
 * this shows today). When a rider page's request is answered "this is part of
 * Premium" (HTTP 402, code premium_required) or with a trimmed list (the
 * X-Premium-Limited header: past history hidden), every rider page shows the
 * same bar with a link to /rider/premium. Watching fetch once covers every
 * rider page, the same way the rider app does it in one place.
 */
export const PREMIUM_EVENT = "rm-premium-required";

const LIMITED_MESSAGES: Record<string, string> = {
  history: "You're seeing today's races only. Past races, laps and trends are part of RM Roost Premium.",
  practice: "You're seeing the last 24 hours of practice. Older sessions are part of RM Roost Premium.",
};

let installed = false;

export function watchForPremiumRequired(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    try {
      const limited = res.headers.get("X-Premium-Limited");
      if (limited && LIMITED_MESSAGES[limited]) {
        window.dispatchEvent(new CustomEvent(PREMIUM_EVENT, { detail: LIMITED_MESSAGES[limited] }));
      } else if (res.status === 402) {
        void res.clone().json().then((body: { code?: string; error?: string }) => {
          if (body?.code === "premium_required") {
            window.dispatchEvent(new CustomEvent(PREMIUM_EVENT, { detail: body.error ?? "This is part of RM Roost Premium." }));
          }
        }).catch(() => {});
      }
    } catch { /* never get in the way of the request */ }
    return res;
  };
}
