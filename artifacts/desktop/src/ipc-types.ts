export type SyncStatus = "idle" | "syncing" | "offline" | "error";

export interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  cloudUrl: string | null;
  clubId: string | null;
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

export interface MyLapsStatus {
  connected: boolean;
  decoderIp: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
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
  "mylaps:connect": (ip: string) => void;
  "mylaps:disconnect": () => void;
  "mylaps:getStatus": () => MyLapsStatus;
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
