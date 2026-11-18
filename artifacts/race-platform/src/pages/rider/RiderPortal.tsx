import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  User, UserPlus, TrendingUp, Check, ChevronRight, ChevronDown, ChevronUp, Bike, Trash2, Plus, Loader2,
  Users, Zap, Smartphone, Link2, Shield, LogOut, AlertCircle, Crown } from "lucide-react";
import { cardSummary, nextMaintenance, recentFinishes } from "@workspace/rider-insights/profileCard";
import { FollowingFeed } from "@/pages/rider/RiderFollowing";
import { NumberPlate } from "@/components/rider/ProfileSettings";
import { RiderAvatar } from "@/components/rider/RacerPhotos";
import { RiderLayout } from "@/components/layout/RiderLayout";
import { useRiderAuth } from "@/contexts/RiderAuthContext";
import { useActiveRiders } from "@/lib/rider-active";
import { riderApi, type RiderBike, type RiderProfile } from "@/lib/rider-api";

// The rider app's Profile tab (rider-app/app/(tabs)/profile.tsx and
// components/RiderCard.tsx): checked riders get the full card with three tiles,
// unchecked riders a slim row; then My Garage, Settings and Sign out.

const sectionLabel = "font-heading font-bold uppercase tracking-[1px] text-[14px] text-[#A8A8A8]";

/** Finishing positions as a tiny line, P1 at the top (same as the app's rider card). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <TrendingUp size={22} className="text-[#A8A8A8]" />;
  const w = 84, h = 28, pad = 3;
  const max = Math.max(...values), min = Math.min(...values), span = Math.max(1, max - min);
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (w - pad * 2), pad + ((v - min) / span) * (h - pad * 2)]);
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="max-w-[84px]" aria-hidden="true">
      <polyline points={pts.map(p => p.join(",")).join(" ")} fill="none" stroke="#FFFFFF" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="#FFFFFF" />
    </svg>
  );
}

// Maintenance status dots (fills only), readable on the dark card.
const STATUS_DOT: Record<string, string> = { overdue: "#EF4444", due_soon: "#F5B700", ok: "#22c55e", unknown: "#7A7A7A" };

function CheckCircle({ on }: { on: boolean }) {
  return (
    <span className={`flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 ${on ? "border-[#B30000] bg-[#B30000]" : "border-[#3A3A3A]"}`}>
      {on && <Check size={14} strokeWidth={3} className="text-white" />}
    </span>
  );
}

function Tile({ href, title, children, label }: { href: string; title: string; children: ReactNode; label: string }) {
  return (
    <Link href={href} aria-label={label}
      className="flex min-h-[112px] min-w-0 flex-1 flex-col gap-1.5 rounded-xl border border-[#3A3A3A] bg-[#2E2E2E] p-2.5 sm:p-3 transition-colors hover:border-[#5A5A5A]">
      <span className="truncate font-heading font-bold uppercase text-[10px] leading-[12px] sm:text-[12px] sm:leading-4 sm:tracking-[0.5px] text-[#A8A8A8]">{title}</span>
      <span className="flex flex-1 flex-col justify-between gap-1.5">{children}</span>
    </Link>
  );
}

function RiderCard({ profile, selected, isOnlyOne, onToggle }: {
  profile: RiderProfile; selected: boolean; isOnlyOne: boolean; onToggle: () => void;
}) {
  const { data } = useQuery({ queryKey: ["rider-card", profile.id], queryFn: () => riderApi.card(profile.id), enabled: selected });
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  const summary = cardSummary(profile);
  const checkLabel = selected ? (isOnlyOne ? `${name} is shown. At least one rider stays checked.` : `Hide ${name}`) : `Show ${name}`;
  const ident = (
    <span className="flex shrink-0 items-center gap-2">
      {(profile.avatarUrl || !profile.bibNumber) && <RiderAvatar url={profile.avatarUrl} name={name} size={selected ? 44 : 38} />}
      {profile.bibNumber ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={selected ? 34 : 28} /> : null}
    </span>
  );

  if (!selected) {
    return (
      <button type="button" role="checkbox" aria-checked={false} aria-label={checkLabel} onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-2xl border border-[#3A3A3A] bg-[#242424] px-3.5 py-2.5 text-left transition-colors hover:bg-[#2E2E2E]">
        {ident}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold text-white">{name}</span>
          <span className="block truncate text-[12px] text-[#A8A8A8]">{summary}</span>
        </span>
        <CheckCircle on={false} />
      </button>
    );
  }

  const finishes = data ? recentFinishes(data.recent) : [];
  const next = data ? nextMaintenance(data.maintenance, Date.now()) : null;
  const hasBike = (profile.bikes?.length ?? 0) > 0;
  const followers = data?.followerCount ?? 0;

  return (
    <div className="space-y-3 rounded-2xl border-[1.5px] border-[#B30000] bg-[#242424] p-3.5">
      <div className="flex items-center gap-3">
        <Link href={`/rider/portal/${profile.id}`} className="group flex min-w-0 flex-1 items-center gap-3">
          {ident}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-heading font-extrabold uppercase tracking-[0.5px] text-[20px] leading-tight text-white group-hover:underline underline-offset-2">{name}</span>
            {data?.className && <span className="block truncate text-[13px] font-semibold text-white/85">{data.className}</span>}
            <span className="block truncate text-[12px] text-[#A8A8A8]">{summary}</span>
          </span>
        </Link>
        <button type="button" role="checkbox" aria-checked aria-disabled={isOnlyOne} aria-label={checkLabel} title={checkLabel}
          onClick={() => { if (!isOnlyOne) onToggle(); }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full">
          <CheckCircle on />
        </button>
      </div>

      <div className="flex gap-2">
        <Tile href={`/rider/racer/${profile.id}`} title="Racer Profile"
          label={`Racer profile, ${followers} ${followers === 1 ? "follower" : "followers"}`}>
          {profile.bibNumber ? <NumberPlate number={profile.bibNumber} color={data?.plateColor} size={26} /> : <User size={22} className="text-white" />}
          <span className="text-[12px] sm:text-[13px] font-semibold leading-tight text-white">{followers} {followers === 1 ? "follower" : "followers"}</span>
        </Tile>
        <Tile href={`/rider/portal/${profile.id}?tab=stats`} title="Career Stats"
          label={`Career stats${data?.avgFinish != null ? `, average finish P${data.avgFinish.toFixed(1)}` : ""}`}>
          <Sparkline values={finishes} />
          <span className="text-[12px] sm:text-[13px] font-semibold leading-tight text-white">{data?.avgFinish != null ? `Avg P${data.avgFinish.toFixed(1)}` : "No races yet"}</span>
        </Tile>
        <Tile href={`/rider/portal/${profile.id}?tab=profile`} title="Maintenance"
          label={`Maintenance, ${next ? next.label : hasBike ? "set up reminders" : "add your bike"}`}>
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: next ? STATUS_DOT[next.status] : "#3A3A3A" }} />
          <span className={`text-[12px] sm:text-[13px] font-semibold leading-tight ${next?.status === "overdue" ? "text-destructive" : "text-white"}`}>
            {next ? next.label : hasBike ? "Set up reminders" : "Add your bike"}
          </span>
        </Tile>
      </div>
    </div>
  );
}

const bikeName = (b: RiderBike) => [b.bikeYear, b.bikeManufacturer, b.bikeModel].filter(Boolean).join(" ") || "Unnamed bike";
const smallInput = "w-full rounded-lg border border-[#3A3A3A] bg-[#242424] px-3 py-2 text-[15px] text-white placeholder:text-[#8A8A8A] outline-none focus:border-[#FAFAFA]";

/** One rider in My Garage: their bikes, pick the main one, add or remove. */
function GarageRow({ profile, open, onToggle }: { profile: RiderProfile; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ year: "", make: "", model: "" });
  const [error, setError] = useState<string | null>(null);
  const bikes = profile.bikes ?? [];
  const main = bikes.find(b => b.isDefault) ?? bikes[0];
  const done = () => {
    setError(null);
    qc.invalidateQueries({ queryKey: ["rider-profiles"] });
    qc.invalidateQueries({ queryKey: ["rider-card", profile.id] });
  };
  const change = useMutation({
    mutationFn: (op: { kind: "default" | "delete"; bikeId: number } | { kind: "add" }): Promise<unknown> =>
      op.kind === "default" ? riderApi.setDefaultBike(profile.id, op.bikeId)
      : op.kind === "delete" ? riderApi.deleteBike(profile.id, op.bikeId)
      : riderApi.addBike(profile.id, { bikeYear: form.year.trim() || null, bikeManufacturer: form.make.trim() || null, bikeModel: form.model.trim() || null }),
    onSuccess: (_r, op) => {
      if (op.kind === "add") { setAdding(false); setForm({ year: "", make: "", model: "" }); }
      done();
    },
    onError: (e: Error) => setError(e.message),
  });
  const name = `${profile.firstName} ${profile.lastName}`.trim();

  return (
    <div className="overflow-hidden rounded-2xl border border-[#3A3A3A] bg-[#242424]">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 p-3.5 text-left hover:bg-[#2E2E2E]">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#2E2E2E]"><Bike size={19} className="text-white" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-bold text-white">{name}</span>
          <span className="block truncate text-[13px] text-[#A8A8A8]">
            {main ? bikeName(main) : "No bikes yet. Open to add one."}
          </span>
        </span>
        {open ? <ChevronUp size={18} className="text-[#A8A8A8]" /> : <ChevronDown size={18} className="text-[#A8A8A8]" />}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[#3A3A3A] p-3.5">
          <div className={`${sectionLabel} text-[12px]`}>My bikes</div>
          {bikes.length === 0 && !adding && <p className="text-[14px] italic text-[#A8A8A8]">No bikes yet</p>}
          {bikes.map(b => {
            const bs = bikeName(b);
            return (
              <div key={b.id} className={`flex items-center gap-2 rounded-xl border ${b.isDefault ? "border-[#B30000]" : "border-[#3A3A3A]"} bg-[#1c1c1c]`}>
                <button type="button" disabled={change.isPending || b.isDefault}
                  onClick={() => change.mutate({ kind: "default", bikeId: b.id })}
                  aria-label={b.isDefault ? `${bs}, your main bike` : `Make ${bs} your main bike`}
                  className="flex min-h-[48px] flex-1 items-center gap-2.5 px-3 text-left disabled:cursor-default">
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${b.isDefault ? "border-[#B30000] bg-[#B30000]" : "border-[#3A3A3A]"}`}>
                    {b.isDefault && <Check size={11} strokeWidth={3} className="text-white" />}
                  </span>
                  <span className="flex-1 truncate text-[15px] font-semibold text-white">{bs}</span>
                  {b.isDefault && <span className="text-[12px] text-[#A8A8A8]">Main bike</span>}
                </button>
                <button type="button" disabled={change.isPending} aria-label={`Remove ${bs}`}
                  onClick={() => { if (window.confirm(`Remove this bike?\n${bs}`)) change.mutate({ kind: "delete", bikeId: b.id }); }}
                  className="mr-1 flex h-10 w-10 items-center justify-center rounded-lg text-[#A8A8A8] hover:bg-[#2E2E2E] hover:text-white">
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}

          {adding ? (
            <form className="space-y-2 rounded-xl border border-[#3A3A3A] bg-[#1c1c1c] p-3"
              onSubmit={e => { e.preventDefault(); if (form.make.trim() || form.model.trim() || form.year.trim()) change.mutate({ kind: "add" }); }}>
              <input aria-label="Year" inputMode="numeric" placeholder="Year (e.g. 2024)" className={smallInput} value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
              <input aria-label="Make" placeholder="Make (e.g. KTM)" className={smallInput} value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
              <input aria-label="Model" placeholder="Model (e.g. 450 SX-F)" className={smallInput} value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => { setAdding(false); setForm({ year: "", make: "", model: "" }); }}
                  className="min-h-[44px] flex-1 rounded-full bg-[#2E2E2E] text-[14px] font-bold uppercase tracking-[0.5px] text-[#A8A8A8] hover:text-white">Cancel</button>
                <button type="submit" disabled={change.isPending || !(form.make.trim() || form.model.trim() || form.year.trim())}
                  className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full bg-[#B30000] text-[14px] font-bold uppercase tracking-[0.5px] text-white hover:bg-[#990000] disabled:opacity-45">
                  {change.isPending ? <Loader2 size={15} className="animate-spin" /> : null} Add bike
                </button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setAdding(true)}
              className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#3A3A3A] bg-[#2E2E2E] text-[14px] font-semibold text-[#A8A8A8] hover:text-white">
              <Plus size={15} /> Add a bike
            </button>
          )}
          {error && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-[rgba(239,68,68,0.15)] px-3 py-2 text-[14px] text-[#ffb4b4]">
              <AlertCircle size={15} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SettingRow({ href, icon, label, sub, external }: { href: string; icon: ReactNode; label: string; sub?: string; external?: boolean }) {
  const inner = (
    <>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#2E2E2E] text-white">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-white">{label}</span>
        {sub && <span className="block text-[13px] text-[#A8A8A8]">{sub}</span>}
      </span>
      <ChevronRight size={17} className="text-[#A8A8A8]" />
    </>
  );
  const cls = "flex min-h-[56px] items-center gap-3 px-4 py-2.5 hover:bg-[#2E2E2E]";
  return external
    ? <a href={href} className={cls}>{inner}</a>
    : <Link href={href} className={cls}>{inner}</Link>;
}

export default function RiderPortal() {
  // RM Roost Premium (off by default): the row shows only once it's on, or the account has it.
  const { data: premiumInfo } = useQuery<{ enforced: boolean; active: boolean }>({
    queryKey: ["rider-premium"],
    queryFn: () => fetch("/api/rider/premium", { credentials: "include" }).then(r => (r.ok ? r.json() : null)).catch(() => null),
    staleTime: 60_000,
  });
  const premiumShown = !!premiumInfo && (premiumInfo.enforced || premiumInfo.active);
  const { account } = useRiderAuth();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { profiles, isLoading, isError, isActive, toggleActive } = useActiveRiders();
  const [garageOpen, setGarageOpen] = useState<number | null>(null);
  const [showLinkHelp, setShowLinkHelp] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // With every rider unchecked the app falls back to showing all of them; show them all checked too.
  const anyActive = profiles.some(p => isActive(p.id));
  const checked = (id: number) => !anyActive || isActive(id);
  const checkedCount = profiles.filter(p => checked(p.id)).length;

  const signOut = async () => {
    setSigningOut(true);
    await riderApi.logout().catch(() => {});
    // Same as RiderLayout: clear the auth cache so RiderLogin sees the rider signed out.
    queryClient.setQueryData(["rider-auth-me"], null);
    queryClient.removeQueries({ queryKey: ["rider-auth-me"] });
    queryClient.removeQueries({ queryKey: ["rider-profiles"] });
    navigate("/rider/login");
  };

  return (
    <RiderLayout
      title="My Profiles"
      subtitle={<>Signed in as <span className="font-bold text-white">{account?.email}</span></>}
    >
      <div className="mx-auto max-w-3xl space-y-8">
        {/* Riders */}
        <section className="space-y-3">
          <div>
            <h2 className={sectionLabel}>Riders</h2>
            <p className="text-[14px] text-[#A8A8A8]">Checked riders drive the app. Tap the check to show or hide a rider.</p>
          </div>

          {isLoading ? (
            <div className="space-y-2.5">
              {[1, 2].map(i => <div key={i} className="h-36 animate-pulse rounded-2xl bg-[#242424]" />)}
            </div>
          ) : isError ? (
            <div className="rounded-2xl border border-[#3A3A3A] bg-[#242424] p-8 text-center text-[15px] text-[#A8A8A8]">
              Your rider profiles couldn't be loaded. Refresh the page to try again.
            </div>
          ) : profiles.length === 0 ? (
            <div className="space-y-2 rounded-2xl border border-[#3A3A3A] bg-[#242424] p-8 text-center">
              <User size={36} className="mx-auto text-[#A8A8A8] opacity-40" />
              <h3 className="font-heading font-bold text-[17px] uppercase text-white">No Rider Profiles</h3>
              <p className="mx-auto max-w-sm text-[14px] text-[#A8A8A8]">
                No profiles linked yet. Register for an event with this email or add a profile manually.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {profiles.map(p => (
                <RiderCard key={p.id} profile={p} selected={checked(p.id)}
                  isOnlyOne={checked(p.id) && checkedCount === 1}
                  onToggle={() => toggleActive(p.id)} />
              ))}
            </div>
          )}

          <Link href="/rider/new-profile"
            className="flex min-h-[52px] items-center justify-center gap-2 rounded-2xl border border-dashed border-[#3A3A3A] bg-[#2E2E2E] text-[15px] font-semibold text-[#A8A8A8] transition-colors hover:border-[#5A5A5A] hover:text-white">
            <UserPlus size={17} /> Add Rider Profile
          </Link>
        </section>

        {/* My Garage */}
        {profiles.length > 0 && (
          <section className="space-y-3">
            <h2 className={sectionLabel}>My Garage <span className="font-sans normal-case tracking-normal text-[13px] font-normal">— bikes for each rider</span></h2>
            <div className="space-y-2.5">
              {profiles.map(p => (
                <GarageRow key={p.id} profile={p} open={garageOpen === p.id} onToggle={() => setGarageOpen(o => (o === p.id ? null : p.id))} />
              ))}
            </div>
          </section>
        )}

        {/* Riders you follow (same as the app's Home feed) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className={sectionLabel}>Riders you follow</h2>
            <Link href="/rider/following" className="min-h-[44px] inline-flex items-center gap-1 text-[15px] font-semibold text-white hover:underline underline-offset-2">
              Find riders <ChevronRight size={16} />
            </Link>
          </div>
          <FollowingFeed limit={5} />
        </section>

        {/* Settings */}
        <section className="space-y-3">
          <h2 className={sectionLabel}>Settings</h2>
          <div className="divide-y divide-[#3A3A3A] overflow-hidden rounded-2xl border border-[#3A3A3A] bg-[#242424]">
            <SettingRow href="/rider/following" icon={<Users size={16} />} label="Following" sub="Find riders and follow their results" />
            <SettingRow href="/rider/rm-cash" icon={<Zap size={16} />} label="RM Cash" sub="Your Rocky Mountain ATV/MC balance" />
            {premiumShown && <SettingRow href="/rider/premium" icon={<Crown size={16} />} label="RM Roost Premium" sub="Past stats, unlimited Rocky and live streams" />}
            <div>
              <button type="button" onClick={() => setShowLinkHelp(v => !v)} aria-expanded={showLinkHelp}
                className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[#2E2E2E]">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#2E2E2E] text-white"><Link2 size={16} /></span>
                <span className="flex-1 text-[15px] font-semibold text-white">How profiles are linked</span>
                {showLinkHelp ? <ChevronUp size={17} className="text-[#A8A8A8]" /> : <ChevronDown size={17} className="text-[#A8A8A8]" />}
              </button>
              {showLinkHelp && (
                <div className="space-y-1.5 px-4 pb-4 text-[14px] leading-[1.6] text-[#A8A8A8]">
                  <p>Rider profiles are automatically linked to your account by email address.</p>
                  <p>If you register a family member (e.g. a minor) using this email, their profile will also appear here as a separate entry.</p>
                  <p>Contact the event organizer if you need to update the email on an existing registration.</p>
                </div>
              )}
            </div>
            <SettingRow href="/rider-app" icon={<Smartphone size={16} />} label="Get the app" sub="Live timing and race-day alerts on your phone" />
            <SettingRow href="/privacy" icon={<Shield size={16} />} label="Privacy policy" />
          </div>
        </section>

        {/* Account */}
        <section className="divide-y divide-[#3A3A3A] overflow-hidden rounded-2xl border border-[#3A3A3A] bg-[#242424]">
          <button type="button" onClick={signOut} disabled={signingOut}
            className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-[#2E2E2E] disabled:opacity-60">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(239,68,68,0.15)] text-[#ffb4b4]">
              {signingOut ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
            </span>
            <span className="flex-1 text-[15px] font-semibold text-[#ffb4b4]">Sign out</span>
          </button>
          <Link href="/delete-account" className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 hover:bg-[#2E2E2E]">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgba(239,68,68,0.15)] text-[#ffb4b4]"><Trash2 size={16} /></span>
            <span className="flex-1 text-[15px] font-semibold text-[#ffb4b4]">Delete account</span>
            <ChevronRight size={17} className="text-[#A8A8A8]" />
          </Link>
        </section>
      </div>
    </RiderLayout>
  );
}
