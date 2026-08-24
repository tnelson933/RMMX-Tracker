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
