import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";

import { podiumColor } from "@/components/RaceStats";
import { PhotoFade, StockBackdrop } from "@/components/StockBackdrop";
import { fmtLapShort } from "@/lib/raceReport";

/**
 * Branded, shareable cards captured as a 1080x1350 PNG (4:5, the size
 * Instagram/Facebook feeds expect) and handed to the system share sheet:
 * a riding photo with the RM Roost banner on top, the rider's name over it,
 * and the result or stats below in the brand type.
 */

const CARD_W = 320;
const CARD_H = 400;
const RED = "#B30000";

export interface CareerStats {
  starts: number;
  finishes: number;
  wins: number;
  podiums: number;
  top5s: number;
  avgFinish: number | null;
  totalLaps: number;
  lapsLed: number;
  pctLapsLed: number | null;
  lap1Leads: number;
  avgLap1Position: number | null;
  positionsGained: number;
  avgPositionsGained: number | null;
  bestLap: { ms: number; eventName: string; motoName: string } | null;
  dnfs?: number;
}

export function formatLap(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${s}` : `${(ms / 1000).toFixed(3)}s`;
}

/** Ref + share() for any capturable view. */
export function useShareCapture() {
  const ref = useRef<View>(null);
  const [sharing, setSharing] = useState(false);
  const share = useCallback(async (dialogTitle: string) => {
    if (!ref.current) return;
    setSharing(true);
    try {
      const uri = await captureRef(ref, { format: "png", quality: 1, width: 1080, height: 1350, result: "tmpfile" });
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Sharing unavailable", "Sharing isn't available on this device.");
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle, UTI: "public.png" });
    } catch (e: any) {
      Alert.alert("Couldn't share", e?.message ?? "Please try again.");
    } finally {
      setSharing(false);
    }
  }, []);
  return { ref, share, sharing };
}

function CardFrame({ eyebrow, name, sub, children, cardRef }: {
  eyebrow: string; name: string; sub?: string; children: React.ReactNode; cardRef: React.RefObject<View | null>;
}) {
  return (
    <View ref={cardRef} collapsable={false} style={c.card}>
      <View style={c.photo}>
        <StockBackdrop />
        <PhotoFade from={0.35} strength={0.95} />
        <Image source={require("../assets/images/brand-banner.png")} style={c.banner} resizeMode="contain" />
        <View style={c.photoText}>
          <Text style={c.eyebrow} numberOfLines={1}>{eyebrow}</Text>
          <Text style={c.name} numberOfLines={1} adjustsFontSizeToFit>{name}</Text>
          {sub ? <Text style={c.sub} numberOfLines={1}>{sub}</Text> : null}
        </View>
      </View>
      <View style={c.rule} />
      <View style={c.body}>{children}</View>
      <Text style={c.footer}>rmroost.com</Text>
    </View>
  );
}

export function StatsShareCard({ name, stats, cardRef }: { name: string; stats: CareerStats; cardRef: React.RefObject<View | null> }) {
  const tiles: Array<[string, string]> = [
    ["Wins", String(stats.wins)],
    ["Podiums", String(stats.podiums)],
    ["Top 5s", String(stats.top5s)],
    ["Avg finish", stats.avgFinish != null ? `P${Math.round(stats.avgFinish)}` : "—"],
    ["Laps led", String(stats.lapsLed)],
    ["Best lap", stats.bestLap ? fmtLapShort(stats.bestLap.ms) : "—"],
  ];
  return (
    <CardFrame cardRef={cardRef} eyebrow="Career stats" name={name} sub={`${stats.starts} motos · ${stats.totalLaps} laps`}>
      <View style={c.grid}>
        {tiles.map(([label, value]) => (
          <View key={label} style={c.tile}>
            <Text style={c.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
            <Text style={c.tileLabel}>{label}</Text>
          </View>
        ))}
      </View>
    </CardFrame>
  );
}

export function ResultShareCard({ name, eventName, raceClass, bestPosition, motos, cardRef }: {
  name: string;
  eventName: string;
  raceClass: string;
  bestPosition: number | null;
  motos: Array<{ motoName: string; position: number | null; dnf?: boolean; dns?: boolean }>;
  cardRef: React.RefObject<View | null>;
}) {
  const metal = podiumColor(bestPosition);
  return (
    <CardFrame cardRef={cardRef} eyebrow={eventName} name={name} sub={raceClass}>
      <View style={c.resultRow}>
        <View style={[c.posBadge, { backgroundColor: metal ?? RED }]}>
          <Text style={[c.posText, { color: metal ? "#14110A" : "#FFFFFF" }]}>{bestPosition ? `P${bestPosition}` : "—"}</Text>
        </View>
        <View style={c.motoList}>
          {motos.slice(0, 4).map((m, i) => (
            <View key={i} style={c.motoRow}>
              <Text style={c.motoName} numberOfLines={1}>{m.motoName}</Text>
              <Text style={c.motoPos}>{m.dns ? "DNS" : m.dnf ? "DNF" : m.position ? `P${m.position}` : "—"}</Text>
            </View>
          ))}
        </View>
      </View>
    </CardFrame>
  );
}

const c = StyleSheet.create({
  card: { width: CARD_W, height: CARD_H, backgroundColor: "#161616", borderRadius: 18, overflow: "hidden" },
  photo: { height: 220, justifyContent: "flex-end", overflow: "hidden", backgroundColor: "#242424" },
  banner: { position: "absolute", top: 12, left: 12, width: 132, height: 42 },
  photoText: { paddingHorizontal: 18, paddingBottom: 12 },
  rule: { width: 72, height: 5, backgroundColor: RED, marginLeft: 18, transform: [{ skewX: "-20deg" }] },
  body: { paddingHorizontal: 18, paddingTop: 14 },
  eyebrow: { color: "#E6E6E6", fontSize: 12, letterSpacing: 1.6, textTransform: "uppercase", fontFamily: "Barlow_700Bold" },
  name: { color: "#FFFFFF", fontSize: 32, lineHeight: 34, textTransform: "uppercase", fontFamily: "Barlow_800ExtraBold_Italic" },
  sub: { color: "#E6E6E6", fontSize: 13, fontFamily: "Roboto_500Medium" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: 88, paddingVertical: 8, borderRadius: 10, backgroundColor: "#242424", alignItems: "center" },
  tileValue: { color: "#FFFFFF", fontSize: 22, fontFamily: "Barlow_800ExtraBold_Italic" },
  tileLabel: { color: "#A8A8A8", fontSize: 10, letterSpacing: 1, textTransform: "uppercase", fontFamily: "Barlow_700Bold" },
  resultRow: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  posBadge: { borderRadius: 10, paddingHorizontal: 16, height: 74, minWidth: 96, alignItems: "center", justifyContent: "center", transform: [{ skewX: "-8deg" }] },
  posText: { fontSize: 52, lineHeight: 60, fontFamily: "Barlow_800ExtraBold_Italic" },
  motoList: { flex: 1, gap: 5 },
  motoRow: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#242424", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  motoName: { color: "#C8C8C8", fontSize: 12, flex: 1, fontFamily: "Roboto_500Medium" },
  motoPos: { color: "#FFFFFF", fontSize: 13, fontFamily: "Barlow_800ExtraBold_Italic" },
  footer: { position: "absolute", bottom: 12, right: 18, color: "#8C8C8C", fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", fontFamily: "Barlow_700Bold" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center", gap: 20, padding: 24 },
  modalActions: { flexDirection: "row", gap: 12 },
  modalBtn: { minWidth: 120, alignItems: "center", backgroundColor: RED, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 20 },
  modalCancel: { backgroundColor: "#333" },
  modalBtnText: { color: "#fff", fontSize: 16, textTransform: "uppercase", letterSpacing: 1, fontFamily: "Barlow_700Bold" },
});

/** "Share result" button that opens a preview of the result card, then the share sheet. */
export function ShareResultButton(props: {
  name: string; eventName: string; raceClass: string; bestPosition: number | null;
  motos: Array<{ motoName: string; position: number | null; dnf?: boolean; dns?: boolean }>;
  color: string;
}) {
  const [open, setOpen] = useState(false);
  const { ref, share, sharing } = useShareCapture();
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-end", opacity: pressed ? 0.6 : 1 })}>
        <Feather name="share" size={14} color={props.color} />
        <Text style={{ fontSize: 13, color: props.color, fontFamily: "Roboto_600SemiBold" }}>Share result</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={c.modalBackdrop}>
          <ResultShareCard {...props} cardRef={ref} />
          <View style={c.modalActions}>
            <Pressable onPress={() => setOpen(false)} style={({ pressed }) => [c.modalBtn, c.modalCancel, { opacity: pressed ? 0.7 : 1 }]}>
              <Text style={c.modalBtnText}>Close</Text>
            </Pressable>
            <Pressable disabled={sharing} onPress={() => share(`${props.name} at ${props.eventName}`)} style={({ pressed }) => [c.modalBtn, { opacity: pressed || sharing ? 0.7 : 1 }]}>
              {sharing ? <ActivityIndicator color="#fff" /> : <Text style={c.modalBtnText}>Share</Text>}
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}
