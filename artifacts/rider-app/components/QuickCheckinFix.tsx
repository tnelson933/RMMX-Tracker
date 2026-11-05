import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { PdfViewer } from "@/components/PdfViewer";
import { useRiderAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { API_BASE_URL } from "@/lib/apiBase";
import { nativePaymentSheetAvailable, payWithSheet } from "@/lib/payments";

// One "fix it" control per Quick Check-In blocker, so riders can make
// themselves eligible without waiting on staff: pay, sign the waiver, or enter
// the transponder / RFID sticker number they already have.

type Props = {
  registrationId: number;
  reason: string;
  onFixed: () => void;
};

async function errorText(res: Response, fallback: string): Promise<string> {
  try { return (await res.json()).error ?? fallback; } catch { return fallback; }
}

export function QuickCheckinFix({ registrationId, reason, onFixed }: Props) {
  const colors = useColors();
  const { riderFetch } = useRiderAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [waiver, setWaiver] = useState<{ kind: string; text: string | null; pdfUrl: string | null; riderName: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [asGuardian, setAsGuardian] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);

  const post = async (path: string, body: unknown, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await riderFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { setError(await errorText(res, fallback)); return null; }
      return await res.json();
    } catch {
      setError("No connection. Try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const button = (label: string, onPress: () => void, primary = true) => (
    <Pressable disabled={busy} onPress={onPress}
      style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, alignItems: "center", backgroundColor: primary ? colors.primary : "transparent", borderWidth: primary ? 0 : 1, borderColor: colors.border }}>
      {busy ? <ActivityIndicator color={primary ? "#fff" : colors.foreground} size="small" />
        : <Text style={{ color: primary ? "#fff" : colors.foreground, fontWeight: "700", fontFamily: "Roboto_700Bold", fontSize: 13 }}>{label}</Text>}
    </Pressable>
  );

  const input = (placeholder: string) => (
    <TextInput value={value} onChangeText={t => { setValue(t); setError(null); }} placeholder={placeholder}
      placeholderTextColor={colors.mutedForeground} autoCapitalize="characters" autoCorrect={false}
      style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, color: colors.foreground, fontFamily: "Roboto_400Regular" }} />
  );

  let body: React.ReactNode = null;

  if (reason === "payment_required") {
    body = button("Pay now", async () => {
      // Paid in the app's own Stripe payment sheet; riders never leave the app.
      const data = await post(`/api/rider/registrations/${registrationId}/checkout`, { paymentSheet: true }, "Couldn't start the payment.");
      if (!data?.paymentSheet?.clientSecret) return;
      if (!nativePaymentSheetAvailable()) { setError("Update RM Roost to pay in the app, or pay at the gate."); return; }
      setBusy(true);
      try {
        const r = await payWithSheet({ ...data.paymentSheet, merchantName: "RM Roost", primaryColor: colors.primary });
        if (r.status === "failed") { setError(r.message); return; }
        if (r.status === "canceled") return;
        // Record it now (the webhook and background check would too, a little later).
        for (let i = 0; i < 6; i++) {
          const v = await fetch(`${API_BASE_URL}/api/public/registrations/${data.registrationId}/verify-payment`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: data.sessionId }),
          }).catch(() => null);
          if (v && v.status !== 402) break;
          await new Promise(res => setTimeout(res, 1500));
        }
        onFixed();
      } finally {
        setBusy(false);
      }
    });
  } else if (reason === "missing_transponder") {
    body = (
      <View style={{ flexDirection: "row", gap: 8 }}>
        {input("Transponder number")}
        {button("Save", async () => {
          if (await post(`/api/rider/registrations/${registrationId}/transponder`, { transponderNumber: value }, "Couldn't save that number.")) onFixed();
        })}
      </View>
    );
  } else if (reason === "missing_rfid") {
    body = (
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {input("Sticker number")}
          {button("Save", async () => {
            if (await post(`/api/rider/registrations/${registrationId}/rfid`, { rfidNumber: value }, "Couldn't save that number.")) onFixed();
          })}
        </View>
        <Text style={{ fontSize: 12, color: colors.mutedForeground, fontFamily: "Roboto_400Regular" }}>
          Already have an RFID sticker on your bike? Enter its number. Need one? Pick it up at the gate.
        </Text>
      </View>
    );
  } else if (reason === "missing_waiver") {
    body = !open ? button("Sign waiver", async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await riderFetch(`/api/rider/registrations/${registrationId}/waiver`);
        if (!res.ok) { setError(await errorText(res, "The waiver isn't available in the app. Sign it at the gate.")); return; }
        setWaiver(await res.json());
        setOpen(true);
      } catch {
        setError("No connection. Try again.");
      } finally {
        setBusy(false);
      }
    }) : waiver && (
      <View style={{ gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12 }}>
        {waiver.text ? (
          <Text style={{ fontSize: 12, color: colors.foreground, fontFamily: "Roboto_400Regular", maxHeight: 220 }} numberOfLines={14}>{waiver.text}</Text>
        ) : null}
        {waiver.pdfUrl ? (
          <Pressable onPress={() => setPdfOpen(true)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Feather name="file-text" size={14} color={colors.primaryText} />
            <Text style={{ color: colors.primaryText, fontFamily: "Roboto_600SemiBold", textDecorationLine: "underline" }}>Read the full waiver</Text>
          </Pressable>
        ) : null}
        {input("Type your full name to sign")}
        <Pressable onPress={() => setAsGuardian(g => !g)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name={asGuardian ? "check-square" : "square"} size={16} color={colors.foreground} />
          <Text style={{ flex: 1, fontSize: 12, color: colors.foreground, fontFamily: "Roboto_400Regular" }}>I'm signing as parent/guardian for {waiver.riderName}</Text>
        </Pressable>
        <Pressable onPress={() => setConsent(c => !c)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name={consent ? "check-square" : "square"} size={16} color={colors.foreground} />
          <Text style={{ flex: 1, fontSize: 12, color: colors.foreground, fontFamily: "Roboto_400Regular" }}>I have read the waiver and agree to sign it electronically</Text>
        </Pressable>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>{button("Sign", async () => {
            if (await post(`/api/rider/registrations/${registrationId}/waiver`, { signerName: value, consentToEsign: consent, asGuardian }, "Couldn't sign the waiver.")) onFixed();
          })}</View>
          <View style={{ flex: 1 }}>{button("Cancel", () => setOpen(false), false)}</View>
        </View>
      </View>
    );
  }

  if (!body) return null;
  return (
    <View style={{ gap: 6, marginTop: 6 }}>
      {body}
      <PdfViewer url={pdfOpen ? waiver?.pdfUrl ?? null : null} title="Waiver" onClose={() => setPdfOpen(false)} />
      {error && <Text style={{ fontSize: 12, color: colors.destructive, fontFamily: "Roboto_400Regular" }}>{error}</Text>}
    </View>
  );
}
