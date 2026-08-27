/** Shared IPC contract between main process and the settings UI. */

export interface AggregateStatus {
  configured: boolean;
  cloudUrl: string;
  email: string;
  readerName: string | null;
  hardware: "impinj" | "zebra" | "generic" | "active_transponder" | null;
  hardwareAddress: string;
  cloud: { connected: boolean; error: string | null };
  state: "disconnected" | "connecting" | "connected_idle" | "testing" | "race_active" | "reconnecting" | "error";
  reconnect: { nextAttemptAt: string | null; secondsUntilAttempt: number | null };
  device: {
    connected: boolean;
    reading: boolean;
    error: string | null;
    lastReadAt: string | null;
    readCount: number;
    antennaIds: number[];
    detail?: string | null;
    transportReady?: boolean;
    heartbeatFresh?: boolean;
    machineId?: string | null;
    loop1State?: string | null;
    loop2State?: string | null;
    diagnosis?: string | null;
    ready?: boolean;
    hostTimezone?: string | null;
    utcOffsetMinutes?: number;
  };
  activeMoto: { motoId: number; name: string } | null;
  testMode: boolean;
  testProgress?: "inactive" | "opening_loops" | "waiting_for_tag" | "sending_crossing" | "confirmed" | "unresolved";
  testMessage?: string | null;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  readers?: Array<{ id: number; name: string; type: string; hardwareAddress: string | null }>;
}

export interface ConnectInput {
  readerId: number;
  hardware: "impinj" | "zebra" | "generic" | "active_transponder";
  hardwareAddress: string;
}
