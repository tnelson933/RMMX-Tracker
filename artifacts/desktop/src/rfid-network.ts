import { LlrpClient, impinjHostFromMac } from "./llrp";
import { RecentReadDeduper } from "./recent-read-deduper";

// Direct LLRP connection from the desktop app to a network RFID reader, so
// RFID timing works on a local network with no internet and no RM Connect.

export type RfidHardware = "impinj" | "zebra" | "generic";

export interface RfidNetworkStatus {
  connected: boolean;
  connecting: boolean;
  reading: boolean;
  hardware: RfidHardware | null;
  host: string | null;
  error: string | null;
  lastReadAt: string | null;
  readCount: number;
  antennaIds: number[];
  reconnecting: boolean;
}

const RECONNECT_DELAY_MS = 5_000;
// Same window RM Connect uses: a reader reports a tag many times per pass.
const DEDUPE_MS = 1_500;

const client = new LlrpClient();
const recentReads = new RecentReadDeduper(DEDUPE_MS);
let wanted = false;
let connecting = false;
let hardware: RfidHardware | null = null;
let host: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let onTagCallback: ((epc: string) => void) | null = null;
let onStatusCallback: ((status: RfidNetworkStatus) => void) | null = null;

/** Impinj readers can be addressed by the last 6 MAC digits printed on the label. */
export function resolveRfidHost(address: string, kind: RfidHardware): string {
  const trimmed = address.trim();
  if (!trimmed) throw new Error("Enter the reader's IP address or hostname.");
  if (kind === "impinj" && !trimmed.includes(".") && /^[0-9a-fA-F]{6}$/.test(trimmed.replace(/[^0-9a-fA-F]/g, ""))) {
    return impinjHostFromMac(trimmed);
  }
  return trimmed;
}

export function getRfidNetworkStatus(): RfidNetworkStatus {
  const s = client.getStatus();
  return {
    connected: s.connected,
    connecting,
    reading: s.reading,
    hardware,
    host: host ?? s.host,
    error: s.error,
    lastReadAt: s.lastReadAt,
    readCount: s.readCount,
    antennaIds: s.antennaIds,
    reconnecting: wanted && !s.connected && !connecting,
  };
}

function pushStatus(): void {
  onStatusCallback?.(getRfidNetworkStatus());
}

async function openSession(): Promise<void> {
  if (!host || !hardware) return;
  connecting = true;
  pushStatus();
  try {
    await client.connect(host, { impinjExtensions: hardware === "impinj" });
    // Read continuously; the local timing server decides whether a moto or
    // practice is running and rejects reads when timing is idle.
    await client.startReading();
  } finally {
    connecting = false;
    pushStatus();
  }
}

function scheduleReconnect(): void {
  if (!wanted || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!wanted) return;
    openSession().catch(() => scheduleReconnect());
  }, RECONNECT_DELAY_MS);
  pushStatus();
}

client.on("tag", (read) => {
  if (recentReads.accept(read.epcHex)) onTagCallback?.(read.epcHex);
  pushStatus();
});
client.on("disconnected", () => {
  pushStatus();
  scheduleReconnect();
});
client.on("error", () => pushStatus());

export async function connectRfidNetworkReader(
  address: string,
  kind: RfidHardware,
  onTag: (epc: string) => void,
  onStatus: (status: RfidNetworkStatus) => void,
): Promise<void> {
  const resolved = resolveRfidHost(address, kind);
  disconnectRfidNetworkReader();
  onTagCallback = onTag;
  onStatusCallback = onStatus;
  hardware = kind;
  host = resolved;
  wanted = true;
  try {
    await openSession();
  } catch (err) {
    // A failed first attempt is reported to the user instead of retried.
    wanted = false;
    pushStatus();
    throw err;
  }
}

export function disconnectRfidNetworkReader(): void {
  wanted = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  void client.disconnect().catch(() => {});
  pushStatus();
}
