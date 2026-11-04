/**
 * Profile tab on the rider website (matches the app's rider screen): racer
 * profile settings (who can see it, number-plate colour, bio) and who can
 * manage the profile. Riders under 18 are private unless a parent or manager
 * makes them public.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2, Mail, UserCheck, XCircle } from "lucide-react";
import { BIO_MAX, PLATE_COLORS, PLATE_COLOR_NAMES } from "@workspace/rider-insights/plates";

import { riderApi, type RiderProfileDetail } from "@/lib/rider-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RacerPhotosEditor } from "./RacerPhotos";

export function NumberPlate({ number, color, size = 32 }: { number: string; color?: string | null; size?: number }) {
  const c = PLATE_COLORS[color ?? "white"] ?? PLATE_COLORS.white;
  return (
    <span aria-label={`Number ${number}`} className="inline-flex items-center justify-center font-heading font-extrabold italic"
      style={{ minWidth: size * 1.5, height: size, padding: `0 ${size * 0.25}px`, borderRadius: size * 0.2, background: c.bg, color: c.fg,
        borderBottom: `${Math.max(3, size * 0.13)}px solid ${c.border}`, fontSize: size * 0.68, lineHeight: 1 }}>
      {number}
    </span>
  );
}

const sectionTitle = "font-heading font-extrabold italic uppercase text-[20px] text-[#242424]";
const label = "font-heading font-bold uppercase tracking-[1.1px] text-[13px] text-[#707070]";

export function RacerProfileSettings({ riderId }: { riderId: number }) {
  const qc = useQueryClient();
  const { data: detail } = useQuery({ queryKey: ["rider-profile-detail", riderId], queryFn: () => riderApi.profile(riderId) });
  const [bio, setBio] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (payload: Parameters<typeof riderApi.updateRacerProfile>[1]) => riderApi.updateRacerProfile(riderId, payload),
    onSuccess: (updated: RiderProfileDetail) => {
      qc.setQueryData(["rider-profile-detail", riderId], (old: RiderProfileDetail | undefined) => ({ ...(old ?? updated), ...updated }));
      qc.invalidateQueries({ queryKey: ["rider-history", riderId] });
      qc.invalidateQueries({ queryKey: ["racer", riderId] });
      setBio(null);
    },
  });
  if (!detail) return null;
  const vis = detail.effectiveVisibility;
  const bioValue = bio ?? detail.bio ?? "";
  const plate = detail.plateColor ?? "white";

  return (
    <div className="rounded-xl border border-[#E2E2E2] bg-white p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className={sectionTitle}>Racer profile</h3>
        <Link href={`/rider/racer/${riderId}`} className="inline-flex items-center gap-1 text-[15px] font-semibold text-[#B30000] hover:underline">
          View <ChevronRight size={16} />
        </Link>
      </div>

      <RacerPhotosEditor riderId={riderId} name={`${detail.firstName} ${detail.lastName}`.trim()}
        avatarUrl={detail.avatarUrl ?? null} coverUrl={detail.coverUrl ?? null} />

      <div className="space-y-2">
        <div className={label}>Who can see the photos, bio and home state</div>
        <div role="radiogroup" className="inline-flex rounded-full border border-[#D0D0D0] p-1">
          {(["public", "private"] as const).map(v => (
            <button key={v} type="button" role="radio" aria-checked={vis === v} disabled={save.isPending}
              onClick={() => vis !== v && save.mutate({ profileVisibility: v })}
              className={`rounded-full px-5 py-2 font-heading font-bold uppercase tracking-[1px] text-[14px] ${vis === v ? "bg-[#242424] text-white" : "text-[#242424] hover:bg-[#F2F2F2]"}`}>
              {v === "public" ? "Everyone" : "Only us"}
            </button>
          ))}
        </div>
        <p className="text-[13px] text-[#707070]">
          {vis === "public"
            ? "Signed-in riders can find this profile and see the photos, bio and home state."
            : "Other riders see published results only, with initials instead of photos. The profile isn't listed in rider search."}
          {detail.isMinor && detail.profileVisibility == null ? " Riders under 18 start private." : ""}
        </p>
      </div>

      <div className="space-y-2">
        <div className={label}>Number plate</div>
        <div role="radiogroup" className="flex flex-wrap gap-2">
          {PLATE_COLOR_NAMES.map(c => (
            <button key={c} type="button" role="radio" aria-checked={plate === c} aria-label={`${c} plate`} disabled={save.isPending}
              onClick={() => plate !== c && save.mutate({ plateColor: c })}
              className={`rounded-lg border-2 p-1 ${plate === c ? "border-[#242424]" : "border-transparent hover:border-[#D0D0D0]"}`}>
              <NumberPlate number={detail.bibNumber || "00"} color={c} size={28} />
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="racer-bio" className={label}>Bio</label>
        <Textarea id="racer-bio" value={bioValue} maxLength={BIO_MAX} rows={2}
          onChange={e => setBio(e.target.value.slice(0, BIO_MAX))}
          placeholder="e.g. 250 B rider out of Boise. Chasing the Snake River title." />
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-[#707070]">{bioValue.length}/{BIO_MAX}</span>
          <Button size="sm" disabled={save.isPending || bio == null || bioValue === (detail.bio ?? "")}
            onClick={() => save.mutate({ bio: bioValue })}>
            {save.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null} Save bio
          </Button>
        </div>
      </div>
      {save.error ? <p className="text-sm text-destructive">{(save.error as Error).message}</p> : null}
    </div>
  );
}

export function ProfileManagers({ riderId }: { riderId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["rider-managers", riderId], queryFn: () => riderApi.managers(riderId) });
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["rider-managers", riderId] });
  const add = useMutation({
    mutationFn: () => riderApi.addManager(riderId, email.trim()),
    onSuccess: () => { setMsg(`${email.trim()} can manage this profile after signing in to RM Roost with that email.`); setEmail(""); refresh(); },
    onError: (e: Error) => setMsg(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => riderApi.removeManager(riderId, id),
    onSuccess: (_r, id) => {
      setMsg(null);
      const me = data?.managers.find(m => m.id === id)?.isYou;
      if (me) window.location.assign("/rider/portal"); else refresh();
    },
    onError: (e: Error) => setMsg(e.message),
  });
  if (!data) return null;

  return (
    <div className="rounded-xl border border-[#E2E2E2] bg-white p-5 space-y-3">
      <h3 className={sectionTitle}>Who can manage this profile</h3>
      <p className="text-[14px] text-[#707070]">
        {data.isOwner
          ? "Add a second parent or a coach. They'll see this rider's races, schedule and stats in their own RM Roost account."
          : "You're a manager of this profile. Only the profile owner can add people."}
      </p>
      <div className="divide-y divide-[#E2E2E2]">
        {data.managers.map(m => (
          <div key={m.id} className="flex items-center gap-3 py-2.5">
            {m.joined ? <UserCheck size={16} className="text-[#707070]" /> : <Mail size={16} className="text-[#707070]" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-[#242424]">{m.email}{m.isYou ? " (you)" : ""}</div>
              <div className="text-[12px] text-[#707070]">{m.joined ? "Has access" : "Invited: gets access after signing in with this email"}</div>
            </div>
            {(data.isOwner || m.isYou) && (
              <button type="button" aria-label={m.isYou ? "Stop managing this profile" : `Remove ${m.email}`}
                onClick={() => { if (window.confirm(m.isYou ? "Stop managing this profile? You'll lose access to it." : `Remove ${m.email}? They'll lose access to this rider's profile.`)) remove.mutate(m.id); }}
                className="text-[#707070] hover:text-[#B30000]">
                <XCircle size={18} />
              </button>
            )}
          </div>
        ))}
      </div>
      {data.isOwner && (
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (email.trim()) add.mutate(); }}>
          <Input id="manager-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Their email address" aria-label="Manager's email address" />
          <Button type="submit" disabled={add.isPending || !email.trim()}>
            {add.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null} Add
          </Button>
        </form>
      )}
      {msg ? <p className="text-[13px] text-[#242424]">{msg}</p> : null}
    </div>
  );
}
