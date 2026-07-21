/** Shared IPC contract between main process and the settings UI. */

export interface AggregateStatus {
  configured: boolean;
  cloudUrl: string;
  email: string;
  readerName: string | null;
  hardware: "impinj" | "zebra" | "generic" | "mylaps" | null;
  hardwareAddress: string;
  cloud: { connected: boolean; error: string | null };
  device: {
    connected: boolean;
    reading: boolean;
    error: string | null;
    lastReadAt: string | null;
    readCount: number;
    antennaIds: number[];
  };
  activeMoto: { motoId: number; name: string } | null;
  testMode: boolean;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  readers?: Array<{ id: number; name: string; type: string }>;
}

export interface ConnectInput {
  readerId: number;
  hardware: "impinj" | "zebra" | "generic" | "mylaps";
  hardwareAddress: string;
}
