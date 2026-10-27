import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";

/**
 * Branded, shareable cards (RM Roost banner on black) captured as a 1080x1350 PNG
 * (4:5, the size Instagram/Facebook feeds expect) and handed to the system share sheet.
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

function CardFrame({ children, cardRef }: { children: React.ReactNode; cardRef: React.RefObject<View | null> }) {
  return (
    <View ref={cardRef} collapsable={false} style={c.card}>
      <Image source={require("../assets/images/brand-banner.png")} style={c.banner} resizeMode="contain" />
      <View style={c.rule} />
      {children}
      <Text style={c.footer}>rmroost.com</Text>
    </View>
  );
}

export function StatsShareCard({ name, stats, cardRef }: { name: string; stats: CareerStats; cardRef: React.RefObject<View | null> }) {
  const tiles: Array<[string, string]> = [
    ["Wins", String(stats.wins)],
    ["Podiums", String(stats.podiums)],
    ["Top 5s", String(stats.top5s)],
    ["Avg finish", stats.avgFinish != null ? `P${stats.avgFinish}` : "—"],
    ["Laps led", String(stats.lapsLed)],
    ["Led lap 1", String(stats.lap1Leads)],
  ];
  return (
    <CardFrame cardRef={cardRef}>
      <Text style={c.eyebrow}>CAREER STATS</Text>
      <Text style={c.name} numberOfLines={1}>{name.toUpperCase()}</Text>
      <Text style={c.sub}>{stats.starts} races · {stats.totalLaps} laps</Text>
      <View style={c.grid}>
        {tiles.map(([label, value]) => (
          <View key={label} style={c.tile}>
            <Text style={c.tileValue}>{value}</Text>
            <Text style={c.tileLabel}>{label}</Text>
          </View>
        ))}
      </View>
      {stats.bestLap && (
        <Text style={c.best} numberOfLines={1}>Best lap {formatLap(stats.bestLap.ms)}</Text>
      )}
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
  return (
    <CardFrame cardRef={cardRef}>
      <Text style={c.eyebrow} numberOfLines={1}>{eventName.toUpperCase()}</Text>
      <Text style={c.name} numberOfLines={1}>{name.toUpperCase()}</Text>
      <Text style={c.sub}>{raceClass}</Text>
      <Text style={c.bigPos}>{bestPosition ? `P${bestPosition}` : "—"}</Text>
      <View style={c.motoList}>
        {motos.slice(0, 4).map((m, i) => (
          <View key={i} style={c.motoRow}>
            <Text style={c.motoName} numberOfLines={1}>{m.motoName}</Text>
            <Text style={c.motoPos}>{m.dns ? "DNS" : m.dnf ? "DNF" : m.position ? `P${m.position}` : "—"}</Text>
          </View>
        ))}
      </View>
    </CardFrame>
  );
}

const c = StyleSheet.create({
  card: { width: CARD_W, height: CARD_H, backgroundColor: "#000", borderRadius: 18, padding: 20, alignItems: "center" },
  banner: { width: 220, height: 70 },
  rule: { width: 64, height: 3, backgroundColor: RED, marginTop: 8, marginBottom: 14, transform: [{ skewX: "-18deg" }] },
  eyebrow: { color: "#BDBDBD", fontSize: 11, letterSpacing: 2, fontFamily: "Inter_600SemiBold" },
  name: { color: "#fff", fontSize: 24, marginTop: 4, fontFamily: "Inter_700Bold" },
  sub: { color: "#BDBDBD", fontSize: 12, marginTop: 2, fontFamily: "Inter_400Regular" },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", marginTop: 14, gap: 8 },
  tile: { width: 84, paddingVertical: 8, borderRadius: 10, backgroundColor: "#1A1A1A", alignItems: "center" },
  tileValue: { color: "#fff", fontSize: 20, fontFamily: "Inter_700Bold" },
  tileLabel: { color: "#BDBDBD", fontSize: 10, marginTop: 2, fontFamily: "Inter_500Medium" },
  best: { color: "#fff", fontSize: 13, marginTop: 12, fontFamily: "Inter_600SemiBold" },
  bigPos: { color: "#fff", fontSize: 64, lineHeight: 70, marginTop: 6, fontFamily: "Inter_700Bold" },
  motoList: { alignSelf: "stretch", marginTop: 6, gap: 4 },
  motoRow: { flexDirection: "row", justifyContent: "space-between", backgroundColor: "#1A1A1A", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  motoName: { color: "#BDBDBD", fontSize: 12, flex: 1, fontFamily: "Inter_500Medium" },
  motoPos: { color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" },
  footer: { position: "absolute", bottom: 12, color: "#8C8C8C", fontSize: 10, letterSpacing: 1, fontFamily: "Inter_500Medium" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.85)", alignItems: "center", justifyContent: "center", gap: 20, padding: 24 },
  modalActions: { flexDirection: "row", gap: 12 },
  modalBtn: { minWidth: 120, alignItems: "center", backgroundColor: RED, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 20 },
  modalCancel: { backgroundColor: "#333" },
  modalBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_700Bold" },
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
        <Text style={{ fontSize: 13, color: props.color, fontFamily: "Inter_600SemiBold" }}>Share result</Text>
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
