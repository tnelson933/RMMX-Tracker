export type SyncStatus = "idle" | "syncing" | "offline" | "error";

export interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  cloudUrl: string | null;
  clubId: string | null;
  /** True when the most-recent pull actually upserted ≥1 row into local SQLite. */
  rowsChanged: boolean;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
}

export interface SerialStatus {
  connected: boolean;
  portPath: string | null;
  error: string | null;
  lastTagAt: string | null;
  tagCount: number;
}

export interface ActiveTransponderStatus {
  connected: boolean;
  state:
    | "disconnected"
    | "connecting"
    | "connected_idle"
    | "testing"
    | "race_active"
    | "reconnecting"
    | "error";
  deviceIp: string | null;
  port: number | null;
  machineId: string | null;
  error: string | null;
  diagnosis: string;
  lastPassingAt: string | null;
  lastCrossingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  reconnectAttempt: number;
  reconnectCountdownMs: number | null;
  configApplied: boolean;
  loopsReady: boolean;
  /** A transponder pass since the loops were opened: they're reading. */
  loopsReading: boolean;
  ready: boolean;
  activeChannel: number;
  activePower: number;
  loopEnabled: [boolean, boolean];
  reader1State: "open" | "closed" | "unknown";
  reader2State: "open" | "closed" | "unknown";
  batteryPercent: number | null;
  totalTagsRead: number | null;
  differentTagsRead: number | null;
  reader1Working: string | null;
  reader2Working: string | null;
  eventId: string | null;
  /** Why the last attempt failed, while the app keeps retrying (error stays null then). */
  retryReason?: string | null;
  /** False once the RM TrackR stopped sending heartbeats. */
  heartbeatFresh?: boolean;
}

export interface ActiveTransponderConfiguration {
  activeChannel: number;
  activePower: number;
  loopEnabled: [boolean, boolean];
}

export interface CloudCredentials {
  email: string;
  cloudUrl: string;
  clubId: string;
  hasPassword: boolean;
}

export type IpcChannels = {
  "sync:getState": () => SyncState;
  "sync:flush": () => void;
  "sync:setInterval": (ms: number) => void;
  "serial:listPorts": () => SerialPortInfo[];
  "serial:connect": (portPath: string, baudRate?: number) => void;
  "serial:disconnect": () => void;
  "serial:getStatus": () => SerialStatus;
  "active-transponder:connect": (ip?: string) => void;
  "active-transponder:disconnect": () => void;
  "active-transponder:getStatus": () => ActiveTransponderStatus;
  "active-transponder:startTest": () => void;
  "active-transponder:stopTest": () => void;
  "active-transponder:configure": (configuration: ActiveTransponderConfiguration) => void;
  "active-transponder:syncClock": () => void;
  "readers:list": () => ReaderStatus[];
  "readers:add": (input: ReaderInput) => ReaderStatus;
  "readers:update": (id: string, changes: ReaderChanges) => ReaderStatus;
  "readers:remove": (id: string) => void;
  "readers:connect": (id: string) => void;
  "readers:disconnect": (id: string) => void;
  "readers:startTest": (id: string) => void;
  "readers:stopTest": (id: string) => void;
  "readers:configure": (id: string, configuration: ActiveTransponderConfiguration) => void;
  "readers:syncClock": (id: string) => void;
  "auth:getCredentials": () => CloudCredentials | null;
  "auth:setCredentials": (email: string, password: string, cloudUrl: string, clubId: string) => void;
  "auth:clearCredentials": () => void;
  "ai:suggestPointsTable": (body: {
    scoringDescription: string;
    motoDescription?: string;
  }) => { ok: boolean; status: number; data: unknown };
  "ai:tweakPointsTable": (body: {
    instruction: string;
    currentTable: unknown;
  }) => { ok: boolean; status: number; data: unknown };
  "app:getVersion": () => string;
};

export type { NetworkInfo, NetworkAdapter, DiscoveredDevice, ScanResult as NetworkScanResult } from "./network-discovery";
export type { RfidNetworkStatus, RfidHardware } from "./rfid-network";

export interface NetworkProbeResult {
  resolved: string | null;
  kinds: Array<"active_transponder" | "rfid">;
}

export interface RfidNetworkSettings {
  address?: string;
  hardware?: "impinj" | "zebra" | "generic";
}

// Several timing readers at once. Events sent to the window:
//   "readers:status"  (ReaderStatus)    one reader's status changed
//   "readers:changed" (ReaderStatus[])  the list changed (added, removed, renamed, connected, disconnected)
export type { ReaderStatus, ReaderInput, ReaderKind, ReaderState, SavedReader } from "./reader-manager";
import type { ReaderStatus, ReaderInput } from "./reader-manager";

export interface ReaderChanges {
  name?: string;
  address?: string;
  hardware?: "impinj" | "zebra" | "generic";
}
