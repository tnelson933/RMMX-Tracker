import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardTypeOptions, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { API_BASE_URL } from "@/lib/apiBase";
import { NETWORK_ERROR_MESSAGE } from "@/lib/friendlyErrors";
import { goBack } from "@/lib/navigation";
import { nativePaymentSheetAvailable, payWithSheet } from "@/lib/payments";
import {
  EMAIL_RE, EMPTY_GEAR, RM_TRACKR_OPTION_ID, addOnOptions, dollars, entryFeeToday, hasGearStep, normalizeTransponder,
  quote, registrationIsOpen, showsTransponder, soloGearProblem, teamGearProblem, teamProblem, teamSize, trackrOption,
  type RegisterInfo, type TeamGear, type TeamMember, type TrackrChoice,
} from "@/lib/registration";

// Registration without leaving the app. The rider's saved profile fills the
// form; whatever they add or change is saved back to it by the server, so
// next time there's even less to type. Card payments use Stripe's payment
// sheet inside the app; riders never leave it to pay.

type Colors = ReturnType<typeof useColors>;
type StepId = "rider" | "team" | "classes" | "gear" | "bike" | "waiver" | "review";
const STEP_LABELS: Record<StepId, string> = { rider: "Rider", team: "Team", classes: "Classes", gear: "Transponder & add-ons", bike: "Bike", waiver: "Waiver", review: "Review & pay" };

interface Form {
  email: string; firstName: string; lastName: string; phone: string; dateOfBirth: string;
  bibNumber: string; amaNumber: string; clubIdNumber: string;
  streetAddress: string; city: string; homeState: string; zip: string;
  emergencyContact: string; emergencyPhone: string; statsEmailOptIn: boolean;
  classes: string[];
  trackrChoice: TrackrChoice; transponder: string; rfidSticker: boolean; options: string[];
  bikeBrand: string; bikeModel: string; bikeYear: string; sponsors: string;
  teamName: string; members: TeamMember[]; gear: TeamGear[];
}

const EMPTY_FORM: Form = {
  email: "", firstName: "", lastName: "", phone: "", dateOfBirth: "", bibNumber: "", amaNumber: "", clubIdNumber: "",
  streetAddress: "", city: "", homeState: "", zip: "", emergencyContact: "", emergencyPhone: "", statsEmailOptIn: false,
  classes: [], trackrChoice: "", transponder: "", rfidSticker: false, options: [],
  bikeBrand: "", bikeModel: "", bikeYear: "", sponsors: "", teamName: "", members: [], gear: [],
};

const BIKE_BRANDS = ["KTM", "Honda", "Gas Gas", "Husqvarna", "Yamaha", "Kawasaki", "Suzuki", "Beta"];

interface PendingPayment {
  registrationId: number;
  sessionId: string;
  amountCents: number;
  sheet: { clientSecret: string; publishableKey: string; stripeAccount: string | null } | null;
}

interface Done { registrationId: number; riderName: string; raceClasses: string[]; eventName: string; amountPaid: number | null; payAtGate: boolean }

/** Age in years from MM/DD/YYYY or YYYY-MM-DD, or null. */
function ageOf(dob: string): number | null {
  const s = dob.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; } else {
    r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!r) return null;
    m = +r[1]; d = +r[2]; y = +r[3];
  }
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age >= 0 && age < 120 ? age : null;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  try { const j = await res.json(); return j?.error || fallback; } catch { return fallback; }
}

// ── Small building blocks (outside the screen so inputs keep focus) ─────────

function Field({ colors, label, value, onChange, placeholder, keyboardType, autoCapitalize, required, error, half, maxLength, editable = true, hint }: {
  colors: Colors; label: string; value: string; onChange: (v: string) => void; placeholder?: string; keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: "none" | "sentences" | "words" | "characters"; required?: boolean; error?: string | null; half?: boolean; maxLength?: number; editable?: boolean; hint?: string;
}) {
  return (
    <View style={{ flex: half ? 1 : undefined, marginBottom: 12 }}>
      <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Roboto_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 5 }}>
        {label}{required ? " *" : ""}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? "words"}
        autoCorrect={false}
        maxLength={maxLength}
        editable={editable}
        style={{
          fontSize: 16, color: colors.foreground, fontFamily: "Roboto_400Regular",
          borderWidth: 1, borderColor: error ? colors.destructive : colors.border, borderRadius: 10,
          paddingHorizontal: 12, paddingVertical: 11, backgroundColor: editable ? colors.background : colors.muted,
        }}
      />
      {error ? <Text style={{ marginTop: 4, fontSize: 12, color: colors.destructive, fontFamily: "Roboto_400Regular" }}>{error}</Text>
        : hint ? <Text style={{ marginTop: 4, fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>{hint}</Text> : null}
    </View>
  );
}

function Card({ colors, title, children, action }: { colors: Colors; title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 14 }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: 4, height: 16, backgroundColor: colors.primary, transform: [{ skewX: "-18deg" }] }} />
            <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Barlow_800ExtraBold", textTransform: "uppercase", letterSpacing: 0.5 }}>{title}</Text>
          </View>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

function Check({ colors, checked, onPress, label, sub, disabled }: { colors: Colors; checked: boolean; onPress: () => void; label: string; sub?: string; disabled?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, marginBottom: 8,
      borderWidth: 1.5, borderColor: checked ? colors.primary : colors.border, backgroundColor: checked ? colors.primaryTint : pressed ? colors.muted : colors.background,
      opacity: disabled ? 0.5 : 1,
    })}>
      <Feather name={checked ? "check-square" : "square"} size={20} color={checked ? colors.primaryText : colors.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>{label}</Text>
        {sub ? <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

function Radio({ colors, selected, onPress, label, sub }: { colors: Colors; selected: boolean; onPress: () => void; label: string; sub?: string }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12, marginBottom: 8,
      borderWidth: 1.5, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primaryTint : pressed ? colors.muted : colors.background,
    })}>
      <Feather name={selected ? "check-circle" : "circle"} size={20} color={selected ? colors.primaryText : colors.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>{label}</Text>
        {sub ? <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", marginTop: 2 }}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

function Row({ colors, label, value }: { colors: Colors; label: string; value?: string | null }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
      <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_700Bold", textTransform: "uppercase", letterSpacing: 0.5, maxWidth: "45%" }}>{label}</Text>
      <Text style={{ flex: 1, textAlign: "right", fontSize: 14, color: value ? colors.foreground : colors.mutedForeground, fontFamily: "Roboto_500Medium" }}>{value || "—"}</Text>
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────

export default function RegisterScreen() {
  const { eventId: eventIdParam, riderId: riderIdParam, newRider: newRiderParam } = useLocalSearchParams<{ eventId: string; riderId?: string; newRider?: string }>();
  const eventId = Number(eventIdParam);
  const riderId = riderIdParam ? Number(riderIdParam) : null;
  const newRider = newRiderParam === "1" || !riderId;
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { account, riderFetch, refreshProfiles, isAuthenticated } = useRiderAuth();

  const [info, setInfo] = useState<RegisterInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState<Form>(EMPTY_FORM);
  const [prefilled, setPrefilled] = useState(false);
  const [isMinor, setIsMinor] = useState(false);
  const [editInfo, setEditInfo] = useState(false);
  const [registeredClasses, setRegisteredClasses] = useState<string[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [bibState, setBibState] = useState<"idle" | "checking" | "available" | "taken">("idle");

  // Waivers
  const [ackAccepted, setAckAccepted] = useState(false);
  const [ackAt, setAckAt] = useState<string | null>(null);
  const [signerName, setSignerName] = useState("");
  const [asGuardian, setAsGuardian] = useState(false);
  const [esignConsent, setEsignConsent] = useState(false);
  const [signatureId, setSignatureId] = useState<number | null>(null);

  // Discount code
  const [compInput, setCompInput] = useState("");
  const [comp, setComp] = useState<{ code: string; amount: number; discountType: "fixed" | "percentage" } | null>(null);
  const [compBusy, setCompBusy] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);

  // Submit and payment
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const set = useCallback(<K extends keyof Form>(key: K, value: Form[K]) => {
    setF(prev => ({ ...prev, [key]: value }));
    setFieldErrors(prev => (prev[key as string] ? { ...prev, [key as string]: "" } : prev));
    setStepError(null);
  }, []);

  // ── Load the event and the rider's profile ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/public/events/${eventId}/register-info`);
        if (!res.ok) throw new Error(res.status === 404 ? "This event couldn't be found." : await errorOf(res, `Couldn't load this event (error ${res.status}).`));
        const ev = (await res.json()) as RegisterInfo;
        if (cancelled) return;
        setInfo(ev);
        const size = ev.groupRace ? teamSize(ev.ridersPerGroup) : 0;
        let next: Form = { ...EMPTY_FORM, email: account?.email ?? "", members: Array.from({ length: Math.max(0, size - 1) }, () => ({ firstName: "", lastName: "", email: "" })), gear: Array.from({ length: size }, () => ({ ...EMPTY_GEAR })) };
        if (riderId && !newRiderParam) {
          const [pr, rc] = await Promise.all([
            riderFetch(`/api/rider/profiles/${riderId}`),
            fetch(`${API_BASE_URL}/api/public/events/${eventId}/rider-classes?riderId=${riderId}`),
          ]);
          if (pr.ok) {
            const p = await pr.json();
            const str = (v: unknown) => (v == null ? "" : String(v));
            // Shown as printed on the device; sent lower-case (normalizeTransponder).
            const tx = (normalizeTransponder(p.myLapsTransponderNumber) ?? "").toUpperCase();
            next = {
              ...next,
              email: str(p.email) || next.email,
              firstName: str(p.firstName), lastName: str(p.lastName), phone: str(p.phone), dateOfBirth: str(p.dateOfBirth),
              bibNumber: str(p.bibNumber), amaNumber: str(p.amaNumber), clubIdNumber: str(p.lastClubIdNumber),
              statsEmailOptIn: !!p.lastStatsEmailOptIn,
              streetAddress: str(p.streetAddress), city: str(p.city), homeState: str(p.homeState), zip: str(p.zip),
              emergencyContact: str(p.emergencyContact), emergencyPhone: str(p.emergencyPhone),
              bikeBrand: str(p.bikeManufacturer), bikeModel: str(p.bikeModel), bikeYear: str(p.bikeYear), sponsors: str(p.sponsors),
              transponder: tx, trackrChoice: tx ? "own" : "",
            };
            if (size > 0) next.gear[0] = { ...EMPTY_GEAR, trackrChoice: tx ? "own" : "", trackrNumber: tx, rfidNumber: str(p.rfidNumber) };
            setIsMinor(!!p.isMinor);
            setAsGuardian(!!p.isMinor);
            setPrefilled(true);
          }
          if (rc.ok) {
            const j = await rc.json().catch(() => null);
            setRegisteredClasses(j?.registeredClasses ?? []);
          }
        }
        if (cancelled) return;
        setF(next);
        setSignerName(`${next.firstName} ${next.lastName}`.trim());
        setEditInfo(!next.firstName || !next.lastName);
        setLoadError(null);
      } catch (e: any) {
        if (!cancelled) setLoadError(e instanceof TypeError ? NETWORK_ERROR_MESSAGE : (e?.message ?? "Couldn't load this event."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId, riderId, newRiderParam, account?.email, riderFetch]);

  // ── Live check that the plate number is free (events with unique numbers) ──
  useEffect(() => {
    const bib = f.bibNumber.trim();
    if (!info?.noDuplicateBibs || !bib) { setBibState("idle"); return; }
    setBibState("checking");
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const exclude = riderId && !newRiderParam ? `&excludeRiderId=${riderId}` : "";
      fetch(`${API_BASE_URL}/api/public/events/${eventId}/check-bib?bib=${encodeURIComponent(bib)}${exclude}`, { signal: ctrl.signal })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error("check failed"))))
        .then(j => setBibState(j?.taken ? "taken" : "available"))
        .catch(() => { if (!ctrl.signal.aborted) setBibState("idle"); });
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [f.bibNumber, info?.noDuplicateBibs, eventId, riderId, newRiderParam]);

  const steps = useMemo<StepId[]>(() => {
    if (!info) return ["rider"];
    const list: StepId[] = ["rider"];
    if (info.groupRace) list.push("team");
    list.push("classes");
    if (hasGearStep(info)) list.push("gear");
    list.push("bike");
    if (info.requireWaiver || info.requireLiabilityWaiver) list.push("waiver");
    list.push("review");
    return list;
  }, [info]);
  const step = steps[Math.min(stepIdx, steps.length - 1)];

  const q = useMemo(() => info ? quote(info, {
    classes: f.classes, trackrChoice: f.trackrChoice, rfidSticker: f.rfidSticker, options: f.options, team: f.gear,
    comp: comp ? { amount: comp.amount, discountType: comp.discountType } : null,
  }) : null, [info, f.classes, f.trackrChoice, f.rfidSticker, f.options, f.gear, comp]);

  const minorNow = isMinor || (ageOf(f.dateOfBirth) ?? 99) < 18;
  useEffect(() => { if (minorNow) setAsGuardian(true); }, [minorNow]);

  // ── Validation per step ──
  const validate = (id: StepId): { error: string | null; fields: Record<string, string> } => {
    const fields: Record<string, string> = {};
    if (!info) return { error: null, fields };
    if (id === "rider") {
      if (!f.firstName.trim()) fields.firstName = "Enter a first name.";
      if (!f.lastName.trim()) fields.lastName = "Enter a last name.";
      if (!EMAIL_RE.test(f.email.trim())) fields.email = "Enter a valid email.";
      if (info.requireAma && !f.amaNumber.trim()) fields.amaNumber = "This event needs an AMA number.";
      if (info.requireClubId && !f.clubIdNumber.trim()) fields.clubIdNumber = "This event needs a club ID number.";
      if (bibState === "taken") fields.bibNumber = "That number is taken at this event. Pick another.";
      if (Object.keys(fields).length) return { error: "Fill in the highlighted fields.", fields };
    }
    if (id === "team") return { error: teamProblem(f.teamName, f.members, info.ridersPerGroup), fields };
    if (id === "classes" && f.classes.length === 0) return { error: "Pick at least one class.", fields };
    if (id === "gear") {
      const problem = info.groupRace ? teamGearProblem(info, f.gear) : (showsTransponder(info) ? soloGearProblem(info, f.trackrChoice, f.transponder) : null);
      if (problem) return { error: problem, fields };
    }
    if (id === "waiver") {
      if (info.requireWaiver && !ackAccepted) return { error: "Read and accept the rider acknowledgement to continue.", fields };
      if (info.requireLiabilityWaiver && !signatureId) {
        if (!signerName.trim()) return { error: "Type your full legal name to sign the waiver.", fields };
        if (!esignConsent) return { error: "Agree to sign the waiver electronically to continue.", fields };
      }
    }
    return { error: null, fields };
  };

  const goTo = (i: number) => {
    setStepIdx(i);
    setStepError(null);
    setSubmitError(null);
  };

  const next = () => {
    const v = validate(step);
    if (v.error) {
      setStepError(v.error);
      setFieldErrors(v.fields);
      if (step === "rider" && Object.keys(v.fields).length) setEditInfo(true);
      return;
    }
    goTo(stepIdx + 1);
  };

  const back = () => {
    if (stepIdx === 0) goBack(router);
    else goTo(stepIdx - 1);
  };

  // ── Discount code ──
  const applyComp = async () => {
    const code = compInput.trim().toUpperCase();
    if (!code) return;
    setCompBusy(true);
    setCompError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/public/events/${eventId}/validate-comp-code`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, email: f.email.trim(), firstName: f.firstName.trim(), lastName: f.lastName.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.valid) { setComp(null); setCompError(j.error || "That code isn't valid for this event."); return; }
      setComp({ code, amount: Number(j.amount) || 0, discountType: j.discountType === "percentage" ? "percentage" : "fixed" });
    } catch {
      setCompError("No connection. Try again.");
    } finally {
      setCompBusy(false);
    }
  };

  // ── Payment ──
  const verifyPayment = async (p: PendingPayment): Promise<Done | null> => {
    const res = await fetch(`${API_BASE_URL}/api/public/registrations/${p.registrationId}/verify-payment`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: p.sessionId }),
    });
    if (res.status === 402) return null;
    if (!res.ok) throw new Error(await errorOf(res, "We couldn't confirm the payment. Check My Races in a minute, or contact the organizer."));
    const j = await res.json();
    return { registrationId: j.registrationId, riderName: j.riderName, raceClasses: j.raceClasses ?? [], eventName: j.eventName, amountPaid: j.amountPaid ?? null, payAtGate: false };
  };

  const finish = (d: Done) => {
    setPending(null);
    setDone(d);
    void refreshProfiles().catch(() => {});
  };

  const pay = async (p: PendingPayment) => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (p.sheet && nativePaymentSheetAvailable()) {
        const r = await payWithSheet({
          ...p.sheet,
          merchantName: info?.clubName || "RM Roost",
          email: f.email.trim(),
          name: `${f.firstName} ${f.lastName}`.trim(),
          primaryColor: colors.primary,
        });
        if (r.status === "canceled") { setSubmitError("Payment not finished. Your spot isn't held until you pay."); return; }
        if (r.status === "failed") { setSubmitError(r.message); return; }
        // The card went through; Stripe can take a moment to report it.
        for (let i = 0; i < 6; i++) {
          const d = await verifyPayment(p);
          if (d) { finish(d); return; }
          await new Promise(res => setTimeout(res, 1500));
        }
        finish({ registrationId: p.registrationId, riderName: `${f.firstName} ${f.lastName}`, raceClasses: f.classes, eventName: info?.name ?? "", amountPaid: p.amountCents / 100, payAtGate: false });
        return;
      }
      // Payment only ever happens in the app's own payment sheet; never send riders out to a web page.
      setSubmitError("Card payments aren't available in the app right now. Your entry isn't held until it's paid. Contact the event organizer.");
    } catch (e: any) {
      setSubmitError(e instanceof TypeError ? NETWORK_ERROR_MESSAGE : (e?.message ?? "Something went wrong with the payment."));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Submit ──
  const submit = async () => {
    if (!info || !q) return;
    for (const [i, id] of steps.entries()) {
      if (id === "review") break;
      const v = validate(id);
      if (v.error) { goTo(i); setStepError(v.error); setFieldErrors(v.fields); return; }
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      let sigId = signatureId;
      if (info.requireLiabilityWaiver && !sigId) {
        const res = await fetch(`${API_BASE_URL}/api/public/events/${eventId}/liability-waiver/sign`, {
          method: "POST", headers: { "Content-Type": "application/json", ...(account?.mobileToken ? { Authorization: `Bearer ${account.mobileToken}` } : {}) },
          body: JSON.stringify({
            signerName: signerName.trim(), signerEmail: f.email.trim(), consentToEsign: true,
            signerType: asGuardian ? "guardian" : "self", minorRiderName: asGuardian ? `${f.firstName} ${f.lastName}`.trim() : null,
          }),
        });
        if (!res.ok) throw new Error(await errorOf(res, "Couldn't sign the waiver. Try again."));
        sigId = (await res.json()).signatureId;
        setSignatureId(sigId);
      }
      const group = !!info.groupRace;
      const size = teamSize(info.ridersPerGroup);
      const soloTx = !group && f.trackrChoice === "own" ? (normalizeTransponder(f.transponder) ?? "") : "";
      const optionIds = [...f.options, ...(!group && f.trackrChoice === "buy" ? [RM_TRACKR_OPTION_ID] : [])];
      const body = {
        firstName: f.firstName.trim(), lastName: f.lastName.trim(), email: f.email.trim(), phone: f.phone.trim(), dateOfBirth: f.dateOfBirth.trim(),
        emergencyContact: f.emergencyContact.trim(), emergencyPhone: f.emergencyPhone.trim(),
        streetAddress: f.streetAddress.trim(), city: f.city.trim(), homeState: f.homeState.trim().toUpperCase(), zip: f.zip.trim(),
        bibNumber: f.bibNumber.trim(), amaNumber: f.amaNumber.trim(), clubIdNumber: f.clubIdNumber.trim(),
        bikeBrand: f.bikeBrand.trim(), bikeModel: f.bikeModel.trim(), bikeYear: f.bikeYear.trim(), sponsors: f.sponsors.trim(),
        statsEmailOptIn: f.statsEmailOptIn,
        rentTransponder: !group && f.trackrChoice === "rent",
        purchaseRfidSticker: !group && f.rfidSticker,
        myLapsTransponderNumber: soloTx,
        raceClasses: f.classes,
        selectedPurchaseOptions: (info.purchaseOptions ?? []).filter(o => optionIds.includes(o.id) && !(group && o.id === RM_TRACKR_OPTION_ID)),
        compCode: comp?.code ?? null,
        waiverAcknowledgedAt: info.requireWaiver && ackAccepted ? ackAt : null,
        waiverSnapshot: info.requireWaiver && ackAccepted ? (info.waiverText ?? null) : null,
        liabilityWaiverSignatureId: sigId,
        ...(riderId && !newRiderParam ? { riderId } : {}),
        ...(newRider ? { newRider: true } : {}),
        ...(group ? {
          teamName: f.teamName.trim(),
          teamMembers: f.members.slice(0, size - 1).map(m => ({ firstName: m.firstName.trim(), lastName: m.lastName.trim(), email: m.email.trim() })),
          teamGear: Array.from({ length: size }, (_, i) => {
            const g = f.gear[i] ?? EMPTY_GEAR;
            return { trackrChoice: g.trackrChoice || null, trackrNumber: g.trackrChoice === "own" ? g.trackrNumber.trim() : "", rfidNumber: g.rfidNumber.trim(), buyRfid: g.buyRfid && !g.rfidNumber.trim() };
          }),
        } : {}),
        // Pay in the app's Stripe payment sheet.
        paymentSheet: true,
      };
      const res = await riderFetch(`/api/public/events/${eventId}/register`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Registration didn't go through. Try again.");
      if (j.requiresPayment) {
        const p: PendingPayment = {
          registrationId: j.registrationId, sessionId: j.sessionId, amountCents: Math.round((Number(j.entryFee) || 0) * 100),
          sheet: j.paymentSheet?.clientSecret ? j.paymentSheet : null,
        };
        setPending(p);
        setSubmitting(false);
        await pay(p);
        return;
      }
      finish({ registrationId: j.registrationId, riderName: j.riderName, raceClasses: j.raceClasses ?? f.classes, eventName: j.eventName, amountPaid: null, payAtGate: q.totalCents > 0 && !info.paymentEnabled });
    } catch (e: any) {
      setSubmitError(e instanceof TypeError ? NETWORK_ERROR_MESSAGE : (e?.message ?? "Registration didn't go through. Try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmLeave = () => {
    if (pending && !done) {
      Alert.alert("Leave without paying?", "Your entry isn't held until it's paid. You can register again later.", [
        { text: "Stay", style: "cancel" },
        { text: "Leave", style: "destructive", onPress: () => goBack(router) },
      ]);
      return;
    }
    back();
  };

  // ── Styles ──
  const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: { paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.muted, alignItems: "center", justifyContent: "center" },
    title: { fontSize: 18, color: colors.foreground, fontFamily: "Barlow_800ExtraBold", textTransform: "uppercase", letterSpacing: 0.3 },
    sub: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" },
    body: { padding: 16, paddingBottom: 40 },
    footer: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 12, backgroundColor: colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, gap: 8 },
    primaryBtn: { backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 15, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
    btnText: { color: "#fff", fontSize: 16, fontFamily: "Barlow_700Bold", textTransform: "uppercase", letterSpacing: 1 },
    note: { fontSize: 13, color: colors.mutedForeground, fontFamily: "Roboto_400Regular", lineHeight: 19 },
    err: { fontSize: 13, color: colors.destructive, fontFamily: "Roboto_500Medium", lineHeight: 19 },
    chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1.5, marginRight: 8, marginBottom: 8 },
    link: { color: colors.primaryText, fontFamily: "Roboto_600SemiBold", fontSize: 14 },
  });

  // ── Loading / errors / closed / done ──
  if (loading) {
    return <View style={[s.root, { alignItems: "center", justifyContent: "center" }]}><ActivityIndicator color={colors.primaryText} size="large" /></View>;
  }
  const centered = (icon: keyof typeof Feather.glyphMap, title: string, message: string, extra?: React.ReactNode) => (
    <View style={[s.root, { alignItems: "center", justifyContent: "center", padding: 32, gap: 10 }]}>
      <Feather name={icon} size={40} color={colors.mutedForeground} />
      <Text style={{ fontSize: 20, color: colors.foreground, fontFamily: "Barlow_800ExtraBold", textTransform: "uppercase", textAlign: "center" }}>{title}</Text>
      <Text style={[s.note, { textAlign: "center" }]}>{message}</Text>
      {extra}
      <Pressable onPress={() => goBack(router)} style={{ marginTop: 10 }}><Text style={s.link}>Go back</Text></Pressable>
    </View>
  );
  if (!isAuthenticated) return centered("user", "Sign in to register", "Sign in or create a free rider account first.", <Pressable onPress={() => router.push("/login" as any)}><Text style={s.link}>Sign in</Text></Pressable>);
  if (!info) return centered("alert-circle", "Couldn't load event", loadError ?? "Try again in a minute.");
  if (!registrationIsOpen(info) && !done) return centered("clock", "Registration isn't open", "Entries for this race aren't being taken right now.");

  if (done) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 40, paddingHorizontal: 20 }]}>
        <View style={{ alignItems: "center", gap: 10, marginBottom: 24 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.successTint, alignItems: "center", justifyContent: "center" }}>
            <Feather name="check" size={40} color={colors.success} />
          </View>
          <Text style={{ fontSize: 26, color: colors.foreground, fontFamily: "Barlow_800ExtraBold_Italic", textTransform: "uppercase" }}>You're in!</Text>
          <Text style={[s.note, { textAlign: "center" }]}>{done.riderName} is registered for {done.eventName}.</Text>
        </View>
        <Card colors={colors}>
          <Row colors={colors} label="Confirmation" value={`REG-${String(done.registrationId).padStart(5, "0")}`} />
          <Row colors={colors} label={done.raceClasses.length > 1 ? "Classes" : "Class"} value={done.raceClasses.join(", ")} />
          {done.amountPaid != null ? <Row colors={colors} label="Paid" value={dollars(Math.round(done.amountPaid * 100))} /> : null}
          {done.payAtGate ? <Row colors={colors} label="Fees" value="Pay at the gate" /> : null}
        </Card>
        <Text style={[s.note, { textAlign: "center", marginBottom: 20 }]}>A confirmation email is on its way. Your race shows up in My Races.</Text>
        <Pressable style={s.primaryBtn} onPress={() => router.replace(`/event/${eventId}` as any)}>
          <Text style={s.btnText}>Back to event</Text>
        </Pressable>
        <Pressable style={{ alignItems: "center", marginTop: 16 }} onPress={() => router.replace("/(tabs)/my-races" as any)}>
          <Text style={s.link}>Go to My Races</Text>
        </Pressable>
      </View>
    );
  }

  const fee = entryFeeToday(info);
  const tOpt = trackrOption(info);
  const options = addOnOptions(info);
  const size = info.groupRace ? teamSize(info.ridersPerGroup) : 0;
  const field = (key: keyof Form, label: string, extra: Partial<React.ComponentProps<typeof Field>> = {}) => (
    <Field colors={colors} label={label} value={String(f[key] ?? "")} onChange={v => set(key, v as never)} error={fieldErrors[key as string] || null} {...extra} />
  );

  // ── Step bodies ──
  const riderStep = () => {
    const summary = (
      <>
        <Row colors={colors} label="Name" value={`${f.firstName} ${f.lastName}`.trim()} />
        <Row colors={colors} label="Email" value={f.email} />
        <Row colors={colors} label="Phone" value={f.phone} />
        <Row colors={colors} label="Birth date" value={f.dateOfBirth} />
        <Row colors={colors} label="Number" value={f.bibNumber ? `#${f.bibNumber}` : ""} />
        {info.requireAma || f.amaNumber ? <Row colors={colors} label="AMA #" value={f.amaNumber} /> : null}
        <Row colors={colors} label="Address" value={[f.streetAddress, f.city, [f.homeState, f.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")} />
        <Row colors={colors} label="Emergency" value={[f.emergencyContact, f.emergencyPhone].filter(Boolean).join(" · ")} />
      </>
    );
    const needClubId = !!info.requireClubId;
    return (
      <>
        {prefilled && !editInfo ? (
          <Card colors={colors} title="Your info" action={<Pressable onPress={() => setEditInfo(true)} hitSlop={10}><Text style={s.link}>Edit</Text></Pressable>}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Feather name="zap" size={14} color={colors.success} />
              <Text style={[s.note, { flex: 1 }]}>Filled in from your profile. Tap Edit to change anything.</Text>
            </View>
            {summary}
            {(() => {
              const missing = [!f.phone && "phone", !f.emergencyContact && "emergency contact", !f.dateOfBirth && "birth date"].filter(Boolean) as string[];
              return missing.length ? (
                <Pressable onPress={() => setEditInfo(true)} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
                  <Feather name="plus-circle" size={14} color={colors.primaryText} />
                  <Text style={[s.link, { fontSize: 13, flex: 1 }]}>Add your {missing.join(", ").replace(/, ([^,]*)$/, " and $1")} (saved for next time)</Text>
                </Pressable>
              ) : null;
            })()}
            {needClubId ? <View style={{ marginTop: 12 }}>{field("clubIdNumber", "Club ID #", { required: true, autoCapitalize: "characters" })}</View> : null}
            {bibState === "taken" ? <Text style={[s.err, { marginTop: 8 }]}>Number {f.bibNumber} is taken at this event. Tap Edit to pick another.</Text> : null}
          </Card>
        ) : (
          <>
            {prefilled ? null : (
              <Text style={[s.note, { marginBottom: 12 }]}>Anything you enter is saved to this rider's profile, so next time it's filled in for you.</Text>
            )}
            <Card colors={colors} title="Rider">
              <View style={{ flexDirection: "row", gap: 10 }}>
                {field("firstName", "First name", { required: true, half: true })}
                {field("lastName", "Last name", { required: true, half: true })}
              </View>
              {field("email", "Email", { required: true, keyboardType: "email-address", autoCapitalize: "none", editable: newRider, hint: newRider ? "Use your account email so this rider shows up in your app." : undefined })}
              {field("phone", "Phone", { keyboardType: "phone-pad" })}
              {field("dateOfBirth", "Birth date", { placeholder: "MM/DD/YYYY", keyboardType: "numbers-and-punctuation" })}
              <View style={{ flexDirection: "row", gap: 10 }}>
                {field("bibNumber", "Preferred number", {
                  half: true, keyboardType: "number-pad", maxLength: 4,
                  hint: bibState === "available" ? "Available" : bibState === "checking" ? "Checking…" : undefined,
                  error: bibState === "taken" ? "Taken at this event" : fieldErrors.bibNumber || null,
                })}
                {info.requireAma ? field("amaNumber", "AMA #", { required: true, half: true, autoCapitalize: "characters" }) : field("amaNumber", "AMA # (optional)", { half: true, autoCapitalize: "characters" })}
              </View>
              {needClubId ? field("clubIdNumber", "Club ID #", { required: true, autoCapitalize: "characters" }) : null}
            </Card>
            <Card colors={colors} title="Contact">
              {field("streetAddress", "Street address")}
              <View style={{ flexDirection: "row", gap: 10 }}>
                {field("city", "City", { half: true })}
                <View style={{ width: 70 }}>{field("homeState", "State", { autoCapitalize: "characters", maxLength: 2 })}</View>
                <View style={{ width: 90 }}>{field("zip", "ZIP", { keyboardType: "number-pad", maxLength: 10 })}</View>
              </View>
              {field("emergencyContact", "Emergency contact")}
              {field("emergencyPhone", "Emergency phone", { keyboardType: "phone-pad" })}
            </Card>
          </>
        )}
        <Check colors={colors} checked={f.statsEmailOptIn} onPress={() => set("statsEmailOptIn", !f.statsEmailOptIn)} label="Email me my race stats" sub="Lap times and results after the race." />
      </>
    );
  };

  const teamStep = () => (
    <>
      <Card colors={colors} title="Team">
        <Field colors={colors} label="Team name" required value={f.teamName} onChange={v => set("teamName", v)} />
        <Text style={s.note}>You're rider 1 (team captain). Add your {size - 1 === 1 ? "teammate" : `${size - 1} teammates`} below. We'll fill in anyone already in the system by email.</Text>
      </Card>
      {f.members.map((m, i) => (
        <Card colors={colors} key={i} title={`Rider ${i + 2}`}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Field colors={colors} half label="First name" required value={m.firstName} onChange={v => set("members", f.members.map((x, j) => (j === i ? { ...x, firstName: v } : x)))} />
            <Field colors={colors} half label="Last name" required value={m.lastName} onChange={v => set("members", f.members.map((x, j) => (j === i ? { ...x, lastName: v } : x)))} />
          </View>
          <Field colors={colors} label="Email" required keyboardType="email-address" autoCapitalize="none" value={m.email} onChange={v => set("members", f.members.map((x, j) => (j === i ? { ...x, email: v } : x)))} />
        </Card>
      ))}
    </>
  );

  const classesStep = () => {
    const all = info.raceClasses ?? [];
    return (
      <Card colors={colors} title="Pick your classes">
        {fee > 0 ? <Text style={[s.note, { marginBottom: 10 }]}>{dollars(Math.round(fee * 100))} per class{info.earlyBirdActive ? " (early-bird price)" : ""}.</Text> : null}
        {all.length === 0 ? <Text style={s.note}>This event hasn't listed its classes yet.</Text> : null}
        {all.map(cls => {
          const already = registeredClasses.includes(cls);
          const on = f.classes.includes(cls);
          return (
            <Check key={cls} colors={colors} disabled={already} checked={on || already}
              onPress={() => set("classes", on ? f.classes.filter(c => c !== cls) : [...f.classes, cls])}
              label={cls} sub={already ? "Already registered" : (info.classDetails?.[cls] ?? undefined)} />
          );
        })}
      </Card>
    );
  };

  const gearChoices = (choice: TrackrChoice, onChoice: (c: TrackrChoice) => void, number: string, onNumber: (v: string) => void, who: string) => (
    <>
      <Radio colors={colors} selected={choice === "own"} onPress={() => onChoice("own")} label={`${who} own RM TrackR`} />
      {choice === "own" ? (
        <Field colors={colors} label="RM TrackR number" value={number} onChange={onNumber} autoCapitalize="characters" maxLength={9} placeholder="As printed on it" />
      ) : null}
      {info.transponderRentalEnabled ? (
        <Radio colors={colors} selected={choice === "rent"} onPress={() => onChoice("rent")} label="Rent one for this race"
          sub={info.transponderRentalFee ? `${dollars(Math.round(Number(info.transponderRentalFee) * 100))}, pick it up at check-in` : "Pick it up at check-in"} />
      ) : null}
      {tOpt ? (
        <Radio colors={colors} selected={choice === "buy"} onPress={() => onChoice("buy")} label={`Buy an ${tOpt.name}`} sub={`${dollars(Math.round(Number(tOpt.amount) * 100))}, yours to keep`} />
      ) : null}
      {!info.requireTransponder ? <Radio colors={colors} selected={choice === ""} onPress={() => onChoice("")} label="No transponder" /> : null}
    </>
  );

  const gearStep = () => {
    const rfidFee = Number(info.rfidStickerFee ?? 0);
    return (
      <>
        {showsTransponder(info) && !info.groupRace ? (
          <Card colors={colors} title="Transponder">
            {info.requireTransponder ? <Text style={[s.note, { marginBottom: 10 }]}>This event needs a transponder.</Text> : null}
            {gearChoices(f.trackrChoice, c => set("trackrChoice", c), f.transponder, v => set("transponder", v), "My")}
          </Card>
        ) : null}
        {info.groupRace ? f.gear.map((g, i) => {
          const upd = (patch: Partial<TeamGear>) => set("gear", f.gear.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          const name = i === 0 ? "You" : (`${f.members[i - 1]?.firstName ?? ""}`.trim() || `Rider ${i + 1}`);
          return (
            <Card colors={colors} key={i} title={i === 0 ? "Your gear" : `${name}'s gear`}>
              {showsTransponder(info) ? gearChoices(g.trackrChoice, c => upd({ trackrChoice: c }), g.trackrNumber, v => upd({ trackrNumber: v }), i === 0 ? "My" : "Their") : null}
              {rfidFee > 0 ? (
                <>
                  <Field colors={colors} label="RFID sticker number (if they have one)" value={g.rfidNumber} onChange={v => upd({ rfidNumber: v })} autoCapitalize="characters" />
                  {!g.rfidNumber.trim() ? <Check colors={colors} checked={g.buyRfid} onPress={() => upd({ buyRfid: !g.buyRfid })} label="Buy an RFID sticker" sub={dollars(Math.round(rfidFee * 100))} /> : null}
                </>
              ) : null}
            </Card>
          );
        }) : null}
        {!info.groupRace && rfidFee > 0 ? (
          <Card colors={colors} title="RFID sticker">
            <Check colors={colors} checked={f.rfidSticker} onPress={() => set("rfidSticker", !f.rfidSticker)} label="Buy an RFID sticker" sub={`${dollars(Math.round(rfidFee * 100))}, pick it up at check-in`} />
          </Card>
        ) : null}
        {options.length > 0 ? (
          <Card colors={colors} title="Add-ons">
            {options.map(o => {
              const on = f.options.includes(o.id);
              return <Check key={o.id} colors={colors} checked={on} onPress={() => set("options", on ? f.options.filter(x => x !== o.id) : [...f.options, o.id])} label={o.name} sub={Number(o.amount) > 0 ? dollars(Math.round(Number(o.amount) * 100)) : "Free"} />;
            })}
          </Card>
        ) : null}
      </>
    );
  };

  const bikeStep = () => (
    <Card colors={colors} title="Bike">
      <Text style={{ fontSize: 11, fontWeight: "700", color: colors.mutedForeground, fontFamily: "Roboto_700Bold", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>Brand</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", marginBottom: 6 }}>
        {BIKE_BRANDS.map(b => {
          const on = f.bikeBrand.toLowerCase() === b.toLowerCase();
          return (
            <Pressable key={b} onPress={() => set("bikeBrand", on ? "" : b)} style={[s.chip, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primaryTint : colors.background }]}>
              <Text style={{ fontSize: 14, color: on ? colors.primaryText : colors.foreground, fontFamily: "Roboto_600SemiBold" }}>{b}</Text>
            </Pressable>
          );
        })}
      </View>
      {!BIKE_BRANDS.some(b => b.toLowerCase() === f.bikeBrand.toLowerCase()) ? field("bikeBrand", "Other brand") : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        {field("bikeModel", "Model", { half: true, autoCapitalize: "characters" })}
        <View style={{ width: 90 }}>{field("bikeYear", "Year", { keyboardType: "number-pad", maxLength: 4 })}</View>
      </View>
      {field("sponsors", "Sponsors (optional)", { autoCapitalize: "sentences" })}
      {(info.contingencyBrands ?? []).length > 0 ? (
        <Text style={s.note}>Contingency at this event: {(info.contingencyBrands ?? []).join(", ")}.</Text>
      ) : null}
    </Card>
  );

  const waiverStep = () => (
    <>
      {info.requireWaiver ? (
        <Card colors={colors} title="Rider acknowledgement">
          {info.waiverText ? <Text style={[s.note, { color: colors.foreground, marginBottom: 10 }]}>{info.waiverText}</Text> : null}
          {info.waiverPdfUrl ? (
            <Pressable onPress={() => void WebBrowser.openBrowserAsync(info.waiverPdfUrl!.startsWith("http") ? info.waiverPdfUrl! : `${API_BASE_URL}${info.waiverPdfUrl}`)} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
              <Feather name="file-text" size={16} color={colors.primaryText} />
              <Text style={[s.link, { textDecorationLine: "underline" }]}>Read the full form</Text>
            </Pressable>
          ) : null}
          <Check colors={colors} checked={ackAccepted} onPress={() => { setAckAccepted(!ackAccepted); setAckAt(ackAccepted ? null : new Date().toISOString()); setStepError(null); }} label="I have read and accept this form" />
        </Card>
      ) : null}
      {info.requireLiabilityWaiver ? (
        <Card colors={colors} title="Liability waiver">
          {signatureId ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Feather name="check-circle" size={18} color={colors.success} />
              <Text style={[s.note, { color: colors.foreground }]}>Signed by {signerName}.</Text>
            </View>
          ) : (
            <>
              {info.liabilityWaiverText ? <Text style={[s.note, { color: colors.foreground, marginBottom: 10 }]} numberOfLines={30}>{info.liabilityWaiverText}</Text> : null}
              {info.liabilityWaiverPdfUrl ? (
                <Pressable onPress={() => void WebBrowser.openBrowserAsync(info.liabilityWaiverPdfUrl!.startsWith("http") ? info.liabilityWaiverPdfUrl! : `${API_BASE_URL}${info.liabilityWaiverPdfUrl}`)} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }}>
                  <Feather name="file-text" size={16} color={colors.primaryText} />
                  <Text style={[s.link, { textDecorationLine: "underline" }]}>Read the full waiver</Text>
                </Pressable>
              ) : null}
              <Check colors={colors} checked={asGuardian} onPress={() => { setAsGuardian(!asGuardian); setStepError(null); }}
                label={`I'm signing as parent or guardian of ${`${f.firstName} ${f.lastName}`.trim() || "this rider"}`}
                sub={minorNow ? "This rider is under 18, so a parent or guardian signs." : undefined} />
              <Field colors={colors} label={asGuardian ? "Parent or guardian's full legal name" : "Your full legal name"} required value={signerName} onChange={v => { setSignerName(v); setStepError(null); }} />
              <Check colors={colors} checked={esignConsent} onPress={() => { setEsignConsent(!esignConsent); setStepError(null); }}
                label="I agree to sign electronically" sub="Typing my name is my signature, and I've read the waiver. A copy is emailed to me." />
            </>
          )}
        </Card>
      ) : null}
    </>
  );

  const reviewStep = () => (
    <>
      <Card colors={colors} title="Rider" action={<Pressable onPress={() => goTo(steps.indexOf("rider"))} hitSlop={10}><Text style={s.link}>Edit</Text></Pressable>}>
        <Row colors={colors} label="Name" value={`${f.firstName} ${f.lastName}`} />
        <Row colors={colors} label="Number" value={f.bibNumber ? `#${f.bibNumber}` : ""} />
        <Row colors={colors} label="Email" value={f.email} />
      </Card>
      {info.groupRace ? (
        <Card colors={colors} title="Team" action={<Pressable onPress={() => goTo(steps.indexOf("team"))} hitSlop={10}><Text style={s.link}>Edit</Text></Pressable>}>
          <Row colors={colors} label="Team" value={f.teamName} />
          {f.members.map((m, i) => <Row key={i} colors={colors} label={`Rider ${i + 2}`} value={`${m.firstName} ${m.lastName}`} />)}
        </Card>
      ) : null}
      <Card colors={colors} title={f.classes.length > 1 ? "Classes" : "Class"} action={<Pressable onPress={() => goTo(steps.indexOf("classes"))} hitSlop={10}><Text style={s.link}>Edit</Text></Pressable>}>
        <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Roboto_600SemiBold" }}>{f.classes.join(", ")}</Text>
      </Card>
      {!info.groupRace && showsTransponder(info) ? (
        <Card colors={colors} title="Transponder" action={<Pressable onPress={() => goTo(steps.indexOf("gear"))} hitSlop={10}><Text style={s.link}>Edit</Text></Pressable>}>
          <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Roboto_500Medium" }}>
            {f.trackrChoice === "own" ? `My RM TrackR ${f.transponder.toUpperCase()}` : f.trackrChoice === "rent" ? "Renting one" : f.trackrChoice === "buy" ? `Buying an ${tOpt?.name ?? "RM TrackR"}` : "None"}
          </Text>
        </Card>
      ) : null}
      {q && q.entryCents > 0 && info.paymentEnabled ? (
        <Card colors={colors} title="Discount code">
          {comp ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 15, color: colors.success, fontFamily: "Roboto_700Bold" }}>{comp.code} applied</Text>
              <Pressable onPress={() => { setComp(null); setCompInput(""); }} hitSlop={10}><Text style={s.link}>Remove</Text></Pressable>
            </View>
          ) : (
            <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <View style={{ flex: 1 }}>
                <Field colors={colors} label="Code" value={compInput} onChange={v => { setCompInput(v); setCompError(null); }} autoCapitalize="characters" error={compError} />
              </View>
              <Pressable onPress={applyComp} disabled={compBusy || !compInput.trim()} style={{ marginTop: 22, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.muted, opacity: compInput.trim() ? 1 : 0.5 }}>
                {compBusy ? <ActivityIndicator size="small" color={colors.foreground} /> : <Text style={{ color: colors.foreground, fontFamily: "Roboto_700Bold" }}>Apply</Text>}
              </Pressable>
            </View>
          )}
        </Card>
      ) : null}
      <Card colors={colors} title="Total">
        {q?.lines.map((l, i) => (
          <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 }}>
            <Text style={{ fontSize: 14, color: colors.foreground, fontFamily: "Roboto_400Regular" }}>{l.label}</Text>
            <Text style={{ fontSize: 14, color: l.cents < 0 ? colors.success : colors.foreground, fontFamily: "Roboto_500Medium" }}>{dollars(l.cents)}</Text>
          </View>
        ))}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", paddingTop: 10, marginTop: 6, borderTopWidth: 1, borderTopColor: colors.border }}>
          <Text style={{ fontSize: 15, color: colors.foreground, fontFamily: "Barlow_800ExtraBold", textTransform: "uppercase" }}>{q?.payOnline ? "Due now" : "Due today"}</Text>
          <Text style={{ fontSize: 26, color: colors.foreground, fontFamily: "Barlow_800ExtraBold_Italic" }}>{dollars(q?.payOnline ? q.totalCents : 0)}</Text>
        </View>
        {q && q.totalCents > 0 && !info.paymentEnabled ? <Text style={[s.note, { marginTop: 8 }]}>You'll pay {dollars(q.totalCents)} at the gate.</Text> : null}
        {q?.payOnline ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
            <Feather name="lock" size={13} color={colors.mutedForeground} />
            <Text style={[s.note, { flex: 1, fontSize: 12 }]}>Paid securely through Stripe to {info.clubName || "the club"}.</Text>
          </View>
        ) : null}
      </Card>
    </>
  );

  const bodies: Record<StepId, () => React.ReactNode> = { rider: riderStep, team: teamStep, classes: classesStep, gear: gearStep, bike: bikeStep, waiver: waiverStep, review: reviewStep };
  const isReview = step === "review";
  const primaryLabel = pending ? `Pay ${dollars(pending.amountCents)}` : isReview ? (q?.payOnline ? `Pay ${dollars(q.totalCents)}` : "Register") : "Next";

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Pressable style={s.backBtn} onPress={confirmLeave} hitSlop={8} accessibilityLabel="Back">
            <Feather name={stepIdx === 0 ? "x" : "arrow-left"} size={18} color={colors.foreground} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>{info.name}</Text>
            <Text style={s.sub} numberOfLines={1}>Step {stepIdx + 1} of {steps.length} · {STEP_LABELS[step]}</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 4, marginTop: 12 }}>
          {steps.map((id, i) => (
            <Pressable key={id} disabled={i >= stepIdx || !!pending} onPress={() => goTo(i)} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: i < stepIdx ? colors.foreground : i === stepIdx ? colors.primary : colors.muted }} accessibilityLabel={STEP_LABELS[id]} />
          ))}
        </View>
      </View>

      <KeyboardAwareScrollViewCompat key={step} style={{ flex: 1 }} contentContainerStyle={s.body} bottomOffset={20}>
        {bodies[step]()}
        {stepError ? <Text style={[s.err, { marginTop: 4 }]}>{stepError}</Text> : null}
      </KeyboardAwareScrollViewCompat>

      <View style={s.footer}>
        {submitError ? <Text style={s.err}>{submitError}</Text> : null}
        <Pressable
          style={({ pressed }) => [s.primaryBtn, { opacity: submitting ? 0.7 : pressed ? 0.85 : 1 }]}
          disabled={submitting}
          onPress={() => (pending ? pay(pending) : isReview ? submit() : next())}
        >
          {submitting ? <ActivityIndicator color="#fff" /> : (
            <>
              {pending || (isReview && q?.payOnline) ? <Feather name="credit-card" size={18} color="#fff" /> : null}
              <Text style={s.btnText}>{primaryLabel}</Text>
              {!isReview && !pending ? <Feather name="arrow-right" size={18} color="#fff" /> : null}
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}
