import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Crown, Gift, MessageCircle, Clock, Video } from "lucide-react";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { riderApi } from "@/lib/rider-api";

/**
 * RM Roost Premium on the website: the same plans as the rider app. Bought
 * here it's a Stripe subscription; bought in the app it's an Apple or Google
 * subscription. Either way it belongs to the rider account and works in both.
 */
interface PremiumSummary {
  enforced: boolean;
  active: boolean;
  until: string | null;
  plan: "individual" | "family" | null;
  source: string | null;
  riderIds: number[];
  riders: Array<{ id: number; name: string }>;
  riderSlots: number;
  maxPhones: number;
}

const KEY = ["rider-premium"];
const PLANS = [
  { key: "individualYearly", title: "Premium yearly", price: "$49.99", per: "/year", sub: "1 rider · 1 phone signed in to the app", badge: "Best value" },
  { key: "individualMonthly", title: "Premium monthly", price: "$4.99", per: "/month", sub: "1 rider · 1 phone signed in to the app" },
  { key: "familyYearly", title: "Family yearly", price: "$79.99", per: "/year", sub: "Up to 4 riders · 4 phones signed in to the app" },
] as const;

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(`/api${path}`, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? "Something went wrong. Try again.");
  return data;
}

export default function RiderPremium() {
  const qc = useQueryClient();
  const { data: summary, isLoading } = useQuery<PremiumSummary>({ queryKey: KEY, queryFn: () => call("/rider/premium", "GET") });
  const { data: profiles = [] } = useQuery({ queryKey: ["rider-profiles"], queryFn: riderApi.profiles });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);

  useEffect(() => { if (summary) setChosen(summary.riderIds); }, [summary]);

  // Back from Stripe Checkout: save the new subscription right away.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (!params.get("paid") || !sessionId) return;
    void call("/rider/premium/web-sync", "POST", { sessionId })
      .then(s => qc.setQueryData(KEY, s)).catch(() => {})
      .finally(() => window.history.replaceState({}, "", "/rider/premium"));
  }, [qc]);

  // One rider, or no more riders than the plan covers: cover them without asking.
  useEffect(() => {
    if (!summary?.active || summary.riderIds.length > 0 || profiles.length === 0 || profiles.length > summary.riderSlots) return;
    void call("/rider/premium/riders", "PUT", { riderIds: profiles.map(p => p.id) }).then(s => qc.setQueryData(KEY, s)).catch(() => {});
  }, [summary, profiles, qc]);

  async function run(id: string, fn: () => Promise<void>) {
    setBusy(id); setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }
  const buy = (product: string) => run(product, async () => { window.location.href = (await call("/rider/premium/checkout", "POST", { product })).url; });
  const manage = () => run("manage", async () => { window.location.href = (await call("/rider/premium/portal", "POST")).url; });
  const saveRiders = () => run("riders", async () => { qc.setQueryData(KEY, await call("/rider/premium/riders", "PUT", { riderIds: chosen })); });

  const locked = new Set(summary?.riderIds ?? []);
  const toggle = (id: number) => setChosen(prev => {
    if (locked.has(id)) return prev;
    if (prev.includes(id)) return prev.filter(x => x !== id);
    const slots = summary?.riderSlots ?? 1;
    const open = prev.filter(x => !locked.has(x));
    return [...locked, ...[...open, id].slice(-(slots - locked.size))];
  });

  const boughtIn = summary?.source === "apple" ? "the App Store" : summary?.source === "google" ? "Google Play" : null;

  return (
    <RiderLayout showBack backTo="/rider/portal" backLabel="My Profiles" title="RM Roost Premium" subtitle="One subscription for the website and the app.">
      <div className="max-w-xl mx-auto flex flex-col gap-5">
        {isLoading && <p className="text-[#A8A8A8]">Loading…</p>}
        {error && <p role="alert" className="text-[#FF6B6B] text-[15px]">{error}</p>}

        {summary && !summary.enforced && !summary.active && (
          <div className="rounded-2xl border border-[#3A3A3A] bg-[#242424] p-4 flex gap-3">
            <Gift size={20} className="text-white shrink-0 mt-0.5" />
            <p className="text-[15px] text-white m-0">Every feature is free right now, so there's nothing to buy. Premium plans will appear here when RM Roost starts them.</p>
          </div>
        )}

        {summary?.active ? (
          <>
            <div className="rounded-2xl border border-[#3A3A3A] bg-[#242424] p-4">
              <p className="text-[12px] font-bold uppercase tracking-[1.5px] text-[#A8A8A8] m-0">Your plan</p>
              <p className="font-heading font-extrabold text-[26px] text-white m-0 flex items-center gap-2"><Crown size={22} /> {summary.plan === "family" ? "Premium Family" : "Premium"}</p>
              <p className="text-[14px] text-[#A8A8A8] m-0">
                {summary.until && `Renews or ends ${new Date(summary.until).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} · `}
                {summary.riderSlots} rider{summary.riderSlots === 1 ? "" : "s"} · {summary.maxPhones} phone{summary.maxPhones === 1 ? "" : "s"} in the app
              </p>
              <div className="mt-3">
                {summary.source === "stripe" ? (
                  <button type="button" onClick={manage} disabled={busy != null} className="rounded-full border border-[#5E5E5C] px-4 min-h-[44px] text-white font-semibold hover:bg-[#2E2E2E]">
                    {busy === "manage" ? "Opening…" : "Update card or cancel"}
                  </button>
                ) : boughtIn ? (
                  <p className="text-[14px] text-[#A8A8A8] m-0">Bought in the RM Roost app. Manage or cancel it in your {boughtIn} subscriptions.</p>
                ) : null}
              </div>
            </div>

            <div className="rounded-2xl border border-[#3A3A3A] bg-[#242424] p-4">
              <h2 className="font-heading font-bold uppercase text-[15px] tracking-[1px] text-white m-0 mb-2">Riders with Premium ({summary.riderIds.length} of {summary.riderSlots})</h2>
              {profiles.length === 0 ? (
                <p className="text-[14px] text-[#A8A8A8] m-0">Add a rider profile first; Premium unlocks for the riders you pick here.</p>
              ) : profiles.map(p => (
                <label key={p.id} className="flex items-center gap-3 min-h-[44px] text-white text-[15px]">
                  <input type="checkbox" className="h-5 w-5" checked={chosen.includes(p.id)} disabled={locked.has(p.id)} onChange={() => toggle(p.id)} />
                  <span className="flex-1">{p.firstName} {p.lastName}</span>
                  {locked.has(p.id) && <span className="text-[12px] text-[#A8A8A8]">Premium</span>}
                </label>
              ))}
              {chosen.length > summary.riderIds.length && (
                <button type="button" onClick={saveRiders} disabled={busy != null} className="mt-2 rounded-full bg-[#B30000] px-5 min-h-[44px] text-white font-bold">
                  {busy === "riders" ? "Saving…" : "Save riders"}
                </button>
              )}
              <p className="text-[12px] text-[#A8A8A8] mt-2 mb-0">
                {summary.plan === "individual" ? "Premium covers 1 rider; Family covers up to 4." : "Family covers up to 4 riders."} Changing a rider who already has Premium goes through RM Roost support.
              </p>
            </div>
          </>
        ) : summary ? (
          <>
            <div className="rounded-2xl bg-[#242424] border border-[#3A3A3A] p-4 flex flex-col gap-2.5">
              <p className="font-heading font-extrabold text-[22px] text-white m-0">Get the whole season, not just race day</p>
              {[[Clock, "Every past race and practice: laps, trends and career stats"], [MessageCircle, "Unlimited Rocky: coach, mechanic, training and maintenance plans"], [Video, "Unlimited live streams of every race"]].map(([Icon, text]) => {
                const I = Icon as typeof Clock;
                return <p key={text as string} className="flex items-center gap-2.5 text-[15px] text-white m-0"><I size={16} className="shrink-0" /> {text as string}</p>;
              })}
              <p className="text-[12px] text-[#A8A8A8] m-0">Free: today's live results, registration, check-in, 1 Rocky question every 72 hours and 30 minutes of live streaming.</p>
            </div>

            {PLANS.map(p => (
              <div key={p.key} className="rounded-2xl border border-[#3A3A3A] bg-[#242424] p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-heading font-bold text-[18px] text-white m-0 flex items-center gap-2">
                    {p.title} {"badge" in p && <span className="rounded-full bg-[#B30000] text-white text-[11px] font-bold px-2 py-0.5">{p.badge}</span>}
                  </p>
                  <p className="text-[13px] text-[#A8A8A8] m-0">{p.sub}</p>
                </div>
                <button type="button" onClick={() => buy(p.key)} disabled={!summary.enforced || busy != null}
                  aria-label={`Buy ${p.title} for ${p.price}${p.per}`}
                  className="rounded-full bg-[#B30000] px-4 min-h-[44px] text-white font-bold disabled:opacity-40 whitespace-nowrap">
                  {busy === p.key ? "Opening…" : <>{p.price}<span className="font-normal text-[12px] opacity-80">{p.per}</span></>}
                </button>
              </div>
            ))}
            <p className="text-[12px] text-[#A8A8A8] text-center m-0 flex items-center justify-center gap-1.5">
              <Check size={13} /> Works on the website and in the RM Roost app. Renews automatically until cancelled. No free trial.
            </p>
          </>
        ) : null}
      </div>
    </RiderLayout>
  );
}
