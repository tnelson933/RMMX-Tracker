/** Shared IPC contract between main process and the settings UI. */
import type { ReaderSessionStatus } from "./reader-session";
import type { DiscoveredDevice } from "./discovery";
import type { Hardware } from "./settings-migrations";

export interface AppStatus {
  signedIn: boolean;
  email: string;
  cloudUrl: string;
  readers: ReaderSessionStatus[];
  identifying: boolean;
}

export interface CloudReaderSummary {
  id: number;
  name: string;
  type: string;
  hardwareAddress: string | null;
  /** Already connected from this laptop. */
  onThisLaptop: boolean;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export interface ScanReply {
  ok: boolean;
  error?: string;
  devices?: Array<DiscoveredDevice & {
    /** Reader on this laptop already using this device. */
    inUseBy: string | null;
    /** A cloud registration that already has this address. */
    registeredReaderId: number | null;
  }>;
  scannedHosts?: number;
}

export interface AddReaderInput {
  address: string;
  hardware: Hardware;
  /** Link to an existing RM Roost registration, or null to create one. */
  readerId: number | null;
  /** Name for a new registration. */
  name?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}
