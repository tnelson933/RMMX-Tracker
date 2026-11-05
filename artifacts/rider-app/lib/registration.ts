// In-app registration: the event's options, what the rider picked, and the
// total. Mirrors the website's register page and the server's pricing
// (api-server routes/registrations.ts); the server's figure is the one charged.

export const RM_TRACKR_OPTION_ID = "rm-trackr";

export interface PurchaseOption { id: string; name: string; amount: number | string }

export interface RegisterInfo {
  id: number;
  clubId: number;
  name: string;
  date: string;
  location: string | null;
  trackName: string | null;
  clubName: string | null;
  status: string;
  raceClasses: string[] | null;
  classDetails: Record<string, string> | null;
  entryFee: number | null;
  /** Today's entry fee (early-bird when it applies), from servers that send it. */
  currentEntryFee?: number | null;
  earlyBirdActive?: boolean;
  earlyBirdFee: number | null;
  earlyBirdEndsAt: string | null;
  paymentEnabled: boolean | null;
  requireAma: boolean | null;
  requireClubId: boolean | null;
  requireWaiver: boolean | null;
  requireLiabilityWaiver: boolean | null;
  requireTransponder: boolean | null;
  registrationOpen: string | null;
  registrationClose: string | null;
  transponderRentalEnabled: boolean | null;
  transponderRentalFee: number | null;
  rfidStickerFee: number | null;
  purchaseOptions: PurchaseOption[] | null;
  contingencyBrands: string[] | null;
  noDuplicateBibs: boolean | null;
  groupRace: boolean | null;
  ridersPerGroup: number | null;
  timingTags?: { transponder: boolean; rfid: boolean; fromReaders?: boolean } | null;
  waiverText: string | null;
  waiverPdfUrl: string | null;
  liabilityWaiverText: string | null;
  liabilityWaiverPdfUrl: string | null;
}

export type TrackrChoice = "" | "own" | "rent" | "buy";

export interface TeamMember { firstName: string; lastName: string; email: string }
export interface TeamGear { trackrChoice: TrackrChoice; trackrNumber: string; rfidNumber: string; buyRfid: boolean }
export const EMPTY_GEAR: TeamGear = { trackrChoice: "", trackrNumber: "", rfidNumber: "", buyRfid: false };

export interface Selection {
  classes: string[];
  /** Solo riders: own number, rent, buy, or nothing. */
  trackrChoice: TrackrChoice;
  rfidSticker: boolean;
  /** Add-on ids (never the RM TrackR when the transponder section shows). */
  options: string[];
  team: TeamGear[];
  comp: { amount: number; discountType: "fixed" | "percentage" } | null;
}

const money = (v: number | string | null | undefined) => (v == null || v === "" ? 0 : Number(v) || 0);

export const teamSize = (ridersPerGroup: number | null | undefined) => Math.max(2, ridersPerGroup ?? 2);

/** One to nine hex characters, lower-cased (an RM TrackR's printed ID). */
export function normalizeTransponder(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{1,9}$/.test(v) ? v : null;
}

export function trackrOption(info: RegisterInfo): PurchaseOption | null {
  return (info.purchaseOptions ?? []).find(o => o.id === RM_TRACKR_OPTION_ID) ?? null;
}

/** The transponder section: the event times with RM TrackR, needs one, rents or sells them. */
export function showsTransponder(info: RegisterInfo): boolean {
  const tags = info.timingTags ?? { transponder: true, rfid: true };
  return !!(tags.transponder || info.requireTransponder || info.transponderRentalEnabled || trackrOption(info));
}

/** Add-ons offered as plain checkboxes. */
export function addOnOptions(info: RegisterInfo): PurchaseOption[] {
  const tx = showsTransponder(info);
  return (info.purchaseOptions ?? []).filter(o => !(o.id === RM_TRACKR_OPTION_ID && tx));
}

export function hasGearStep(info: RegisterInfo): boolean {
  if (info.groupRace) return showsTransponder(info) || money(info.rfidStickerFee) > 0 || addOnOptions(info).length > 0;
  return showsTransponder(info) || money(info.rfidStickerFee) > 0 || addOnOptions(info).length > 0;
}

/** Today's entry fee per class. */
export function entryFeeToday(info: RegisterInfo, today = new Date().toISOString().slice(0, 10)): number {
  if (info.currentEntryFee !== undefined) return money(info.currentEntryFee);
  const early = !!(info.earlyBirdEndsAt && today <= info.earlyBirdEndsAt && info.earlyBirdFee);
  return early ? money(info.earlyBirdFee) : money(info.entryFee);
}

export interface Quote {
  entryCents: number;
  discountCents: number;
  rentalCents: number;
  rfidCents: number;
  trackrCents: number;
  optionsCents: number;
  totalCents: number;
  /** True when the rider pays online now; false = nothing due, or pay at the gate. */
  payOnline: boolean;
  lines: Array<{ label: string; cents: number }>;
}

const cents = (v: number | string | null | undefined) => Math.round(money(v) * 100);

/** Same rules as the server: codes discount entry fees only; add-ons are always charged. */
export function quote(info: RegisterInfo, sel: Selection): Quote {
  const perClass = cents(entryFeeToday(info));
  const n = sel.classes.length;
  const entryCents = perClass * n;
  let discountCents = 0;
  if (sel.comp && entryCents > 0) {
    discountCents = Math.min(entryCents, sel.comp.discountType === "percentage"
      ? Math.round(entryCents * sel.comp.amount / 100)
      : Math.round(sel.comp.amount * 100));
  }
  const group = !!info.groupRace;
  const size = group ? teamSize(info.ridersPerGroup) : 0;
  const gear = group ? Array.from({ length: size }, (_, i) => sel.team[i] ?? EMPTY_GEAR) : [];
  const rentals = group ? gear.filter(g => g.trackrChoice === "rent").length : (sel.trackrChoice === "rent" ? 1 : 0);
  const trackrs = group ? gear.filter(g => g.trackrChoice === "buy").length : (sel.trackrChoice === "buy" ? 1 : 0);
  const rfids = group ? gear.filter(g => g.buyRfid && !g.rfidNumber.trim()).length : (sel.rfidSticker ? 1 : 0);
  const rentalCents = info.transponderRentalEnabled ? cents(info.transponderRentalFee) * rentals : 0;
  const rfidCents = money(info.rfidStickerFee) > 0 ? cents(info.rfidStickerFee) * rfids : 0;
  const trackr = trackrOption(info);
  const trackrCents = trackr ? cents(trackr.amount) * trackrs : 0;
  const optionsCents = addOnOptions(info).filter(o => sel.options.includes(o.id)).reduce((s, o) => s + Math.max(0, cents(o.amount)), 0);
  const totalCents = entryCents - discountCents + rentalCents + rfidCents + trackrCents + optionsCents;

  const lines: Quote["lines"] = [];
  if (entryCents) lines.push({ label: n > 1 ? `Entry (${n} classes)` : "Entry", cents: entryCents });
  if (discountCents) lines.push({ label: "Discount", cents: -discountCents });
  if (rentalCents) lines.push({ label: rentals > 1 ? `Transponder rental ×${rentals}` : "Transponder rental", cents: rentalCents });
  if (trackrCents) lines.push({ label: trackrs > 1 ? `${trackr!.name} ×${trackrs}` : trackr!.name, cents: trackrCents });
  if (rfidCents) lines.push({ label: rfids > 1 ? `RFID sticker ×${rfids}` : "RFID sticker", cents: rfidCents });
  for (const o of addOnOptions(info).filter(o => sel.options.includes(o.id) && cents(o.amount) > 0)) lines.push({ label: o.name, cents: cents(o.amount) });

  return { entryCents, discountCents, rentalCents, rfidCents, trackrCents, optionsCents, totalCents, payOnline: !!info.paymentEnabled && totalCents > 0, lines };
}

export const dollars = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

/** Registration is open now by status and its date window (the server checks again). */
export function registrationIsOpen(info: RegisterInfo, now = new Date()): boolean {
  if (info.status !== "registration_open") return false;
  if (info.registrationOpen && new Date(info.registrationOpen) > now) return false;
  if (info.registrationClose && new Date(info.registrationClose) < now) return false;
  return true;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What's missing on the team step, or null. */
export function teamProblem(teamName: string, members: TeamMember[], ridersPerGroup: number | null | undefined): string | null {
  if (!teamName.trim()) return "Enter a team name.";
  for (let i = 0; i < teamSize(ridersPerGroup) - 1; i++) {
    const m = members[i];
    if (!m?.firstName.trim() || !m?.lastName.trim()) return `Enter rider ${i + 2}'s first and last name.`;
    if (!EMAIL_RE.test((m?.email ?? "").trim())) return `Enter a valid email for rider ${i + 2}.`;
  }
  return null;
}

/** A group race's gear problem (bad number, missing required transponder, a number used twice), or null. */
export function teamGearProblem(info: RegisterInfo, gear: TeamGear[]): string | null {
  const size = teamSize(info.ridersPerGroup);
  for (let i = 0; i < size; i++) {
    const g = gear[i] ?? EMPTY_GEAR;
    const who = i === 0 ? "your" : `rider ${i + 1}'s`;
    if (g.trackrChoice === "own" && !normalizeTransponder(g.trackrNumber)) {
      return `Enter ${who} RM TrackR number as printed on it (up to 9 numbers or letters A–F), or pick another option.`;
    }
    if (info.requireTransponder && !g.trackrChoice) {
      return `This event needs a transponder for every rider. Choose one for ${i === 0 ? "yourself" : `rider ${i + 1}`}.`;
    }
  }
  const seen = new Set<string>();
  for (let i = 0; i < size; i++) {
    const g = gear[i] ?? EMPTY_GEAR;
    for (const t of [g.rfidNumber.trim(), g.trackrChoice === "own" ? g.trackrNumber.trim() : ""]) {
      if (!t) continue;
      if (seen.has(t.toLowerCase())) return `Number ${t} is entered twice. Each rider needs their own.`;
      seen.add(t.toLowerCase());
    }
  }
  return null;
}

/** Solo rider's transponder problem, or null. */
export function soloGearProblem(info: RegisterInfo, choice: TrackrChoice, number: string): string | null {
  if (choice === "own" && !normalizeTransponder(number)) {
    return "Enter your RM TrackR number as printed on it (up to 9 numbers or letters A–F), or pick another option.";
  }
  if (info.requireTransponder && !choice) {
    const canGet = !!info.transponderRentalEnabled || !!trackrOption(info);
    return canGet ? "This event needs a transponder. Enter yours, or rent or buy one." : "This event needs a transponder. Enter your transponder number.";
  }
  return null;
}
