/**
 * Cloud link — connects RM Connect to the race platform cloud.
 *
 *   - WebSocket command channel:  wss://<cloud>/api/connector/ws?token=<readerToken>
 *     Receives start_moto / stop_moto commands, sends periodic status.
 *   - Crossings are POSTed to the existing HTTP ingest endpoint:
 *     POST <cloud>/api/timing/readers/<token>/crossing
 */
import WebSocket from "ws";
import { EventEmitter } from "events";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const STATUS_INTERVAL_MS = 15_000;

export interface CloudCommand {
  type: "start_moto" | "stop_moto" | "ping" | "set_llrp_config" | "set_active_timing_config";
  motoId?: number;
  eventId?: number;
  motoName?: string;
  motoType?: string;
  config?: {
    transmitPowerIndex: number;
    rfModeIndex: number;
    tagPopulation: number;
    tagTransitTime: number;
  } | {
    channel: number;
    power: number;
    loop1Enabled: boolean;
    loop2Enabled: boolean;
  };
  syncClock?: boolean;
}

function isValidLlrpConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const value = config as Record<string, unknown>;
  return (
    Number.isInteger(value.transmitPowerIndex) &&
    Number(value.transmitPowerIndex) >= 1 &&
    Number(value.transmitPowerIndex) <= 81 &&
    Number.isInteger(value.rfModeIndex) &&
    Number(value.rfModeIndex) >= 0 &&
    Number(value.rfModeIndex) <= 3 &&
    Number.isInteger(value.tagPopulation) &&
    Number(value.tagPopulation) >= 1 &&
    Number(value.tagPopulation) <= 64 &&
    Number.isInteger(value.tagTransitTime) &&
    Number(value.tagTransitTime) >= 50 &&
    Number(value.tagTransitTime) <= 5000
  );
}

function isValidActiveTimingConfig(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const value = config as Record<string, unknown>;
  return (
    Number.isInteger(value.channel) &&
    Number(value.channel) >= 0 &&
    Number(value.channel) <= 5 &&
    Number.isInteger(value.power) &&
    Number(value.power) >= 0 &&
    Number(value.power) <= 100 &&
    typeof value.loop1Enabled === "boolean" &&
    typeof value.loop2Enabled === "boolean"
  );
}

export interface CloudStatusReport {
  connectorVersion: string;
  hardware: "impinj" | "zebra" | "generic" | "active_transponder" | null;
  connected: boolean;
  /** RFID: connected. RM TrackR: identified, configured and both enabled loops running. */
  ready?: boolean;
  detail: string | null;
  lastReadAt: string | null;
  readCount: number;
  antennaIds: number[];
  hostTimezone?: string | null;
  utcOffsetMinutes?: number;
}

export interface CloudLinkStatus {
  connected: boolean;
  cloudUrl: string | null;
  error: string | null;
}

/**
 * Events:
 *   "command"      (cmd: CloudCommand)
 *   "connected"    ()
 *   "disconnected" (reason: string)
 */
export class CloudLink extends EventEmitter {
  private ws: WebSocket | null = null;
  private cloudUrl: string | null = null;
  private readerToken: string | null = null;
  private lastError: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private statusProvider: (() => CloudStatusReport) | null = null;

  getStatus(): CloudLinkStatus {
    return {
      connected: !!this.ws && this.ws.readyState === WebSocket.OPEN,
      cloudUrl: this.cloudUrl,
      error: this.lastError,
    };
  }

  setStatusProvider(fn: () => CloudStatusReport): void {
    this.statusProvider = fn;
  }

  start(cloudUrl: string, readerToken: string): void {
    this.stop();
    this.stopped = false;
    this.cloudUrl = cloudUrl.replace(/\/+$/, "");
    this.readerToken = readerToken;
    this.reconnectAttempt = 0;
    this.open();

    this.statusTimer = setInterval(() => this.sendStatus(), STATUS_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.discardSocket();
  }

  /** Detach and terminate the current socket. Its handlers ignore events once
   *  it is no longer `this.ws`, so a late close cannot schedule a reconnect. */
  private discardSocket(): void {
    const old = this.ws;
    this.ws = null;
    if (!old) return;
    try {
      old.terminate();
    } catch {
      // ignore
    }
  }

  /** Push a status report to the cloud immediately (also sent on a timer). */
  sendStatus(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.statusProvider) return;
    const s = this.statusProvider();
    try {
      this.ws.send(JSON.stringify({ type: "status", ...s }));
    } catch {
      // socket dying — reconnect logic handles it
    }
  }

  /**
   * POST a crossing to the cloud.
   *
   * Tries the token-based checkpoint endpoint first (used when this reader has
   * an enduro checkpoint assignment: start/finish/time_check routing). If the
   * reader has no checkpoint assignment (regular motocross events), falls back
   * to the stable facility endpoint which routes to the club's in-progress moto.
   */
  async postCrossing(input: {
    rfidNumber: string;
    crossingTime: Date;
    antennaId?: number | null;
    clubId?: number | null;
    eventId?: number | null;
    receivedAtUtc?: Date;
    deviceTimezone?: string | null;
    source?: string;
  }): Promise<{ ok: boolean; message?: string; status?: number }> {
    if (!this.cloudUrl || !this.readerToken) {
      return { ok: false, message: "Cloud link not configured" };
    }
    const payload = JSON.stringify({
      rfidNumber: input.rfidNumber,
      crossingTime: input.crossingTime.toISOString(),
      ...(input.receivedAtUtc ? {
        receivedAtUtc: input.receivedAtUtc.toISOString(),
        receivedAt: input.receivedAtUtc.toISOString(),
        readerReceivedAt: input.receivedAtUtc.toISOString(),
      } : {}),
      ...(input.deviceTimezone ? { deviceTimezone: input.deviceTimezone } : {}),
      ...(input.source ? { source: input.source, timeSource: input.source } : {}),
      ...(input.antennaId != null ? { antennaId: input.antennaId } : {}),
      ...(input.eventId != null ? { eventId: input.eventId } : {}),
    });
    const headers = { "Content-Type": "application/json" };

    const tokenUrl = `${this.cloudUrl}/api/timing/readers/${this.readerToken}/crossing`;
    const res = await fetch(tokenUrl, { method: "POST", headers, body: payload, keepalive: true });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };

    // 422 "no checkpoint assignment" → not an enduro setup; use facility routing.
    // Practice sessions also have no race_day event, so the token endpoint
    // returns 422 before it can route them; those must use the same fallback.
    const tokenMessage = (data.message ?? "").toLowerCase();
    const shouldUseFacilityRouting = res.status === 422 && (
      tokenMessage.includes("assignment") ||
      tokenMessage.includes("no active race_day event")
    );
    if (!shouldUseFacilityRouting) {
      return { ok: !!data.ok, message: data.message, status: res.status };
    }

    // The facility URL is addressed by club ID, so authenticate with this
    // reader's token. Servers without ingest auth ignore the header; servers
    // with it reject a facility post without a credential once the club enforces.
    // When no clubId was saved with the sign-in, use the per-reader facility
    // URL, which takes the club from the reader token instead of failing.
    const facilityUrl = input.clubId
      ? `${this.cloudUrl}/api/timing/active/crossing?clubId=${input.clubId}`
      : `${this.cloudUrl}/api/timing/readers/${encodeURIComponent(this.readerToken)}/active/crossing`;
    const res2 = await fetch(facilityUrl, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${this.readerToken}` },
      body: payload,
      keepalive: true,
    });
    const data2 = (await res2.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: !!data2.ok, message: data2.message ?? data2.error, status: res2.status };
  }

  private open(): void {
    if (this.stopped || !this.cloudUrl || !this.readerToken) return;

    const wsUrl =
      this.cloudUrl.replace(/^http/, "ws") +
      `/api/connector/ws?token=${encodeURIComponent(this.readerToken)}`;

    // Never leave a previous socket alive alongside the new one.
    this.discardSocket();
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      const socket = (ws as any)._socket;
      socket?.setNoDelay?.(true);
      socket?.setKeepAlive?.(true, 1_000);
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.emit("connected");
      this.sendStatus();
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const command = msg as CloudCommand;
      if (command.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          // ignore
        }
        return;
      }
      if (command.type === "start_moto" || command.type === "stop_moto") {
        this.emit("command", command);
      } else if (command.type === "set_llrp_config" && isValidLlrpConfig(command.config)) {
        this.emit("command", command);
      } else if (command.type === "set_active_timing_config" && isValidActiveTimingConfig(command.config)) {
        this.emit("command", command);
      }
    });

    ws.on("error", (err) => {
      // A replaced/stopped socket must not overwrite the live socket's state.
      if (this.ws !== ws) return;
      this.lastError = err.message;
    });

    ws.on("close", (code) => {
      // Ignore late closes from a socket that stop()/open() already replaced;
      // otherwise it would schedule a reconnect and orphan the live socket.
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      if (code === 1008 || this.lastError?.includes("401")) {
        this.lastError = "RM Roost no longer knows this reader (it was removed or given a new token). Remove it here and add it again with Find readers.";
      }
      this.emit("disconnected", this.lastError ?? `Connection closed (${code})`);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}

// ── Cloud HTTP helpers (login + reader list) ──────────────────────────────────

export interface CloudReader {
  id: number;
  name: string;
  type: string;
  token: string;
  hardwareAddress?: string | null;
  activeTimingConfig?: {
    channel: number;
    power: number;
    loop1Enabled: boolean;
    loop2Enabled: boolean;
  } | null;
}

// ── Laptop pairing and the club's reader list ────────────────────────────────

async function apiError(res: Response, fallback: string): Promise<Error & { status: number }> {
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return Object.assign(new Error(data.error ?? data.message ?? `${fallback} (${res.status})`), { status: res.status });
}

/** Trade a 6-digit pairing code from Reader Setup for this laptop's own key. */
export async function pairLaptop(
  cloudUrl: string,
  code: string,
  laptopName: string,
): Promise<{ laptopKey: string; clubId: number; clubName: string | null }> {
  const base = cloudUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/connector/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.replace(/\D/g, ""), laptopName }),
  });
  if (!res.ok) throw await apiError(res, "Pairing failed");
  return (await res.json()) as { laptopKey: string; clubId: number; clubName: string | null };
}

function laptopHeaders(laptopKey: string, json = false): Record<string, string> {
  return { Authorization: `Bearer ${laptopKey}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

/** Register a reader for the club (RM Connect does this when it finds new hardware). */
export async function createReader(
  cloudUrl: string,
  laptopKey: string,
  input: { name: string; type: "rfid" | "active_transponder"; hardwareAddress: string },
): Promise<CloudReader> {
  const base = cloudUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/connector/laptop/readers`, {
    method: "POST",
    headers: laptopHeaders(laptopKey, true),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "Couldn't add the reader");
  return (await res.json()) as CloudReader;
}

/** Rename a reader and/or save the address RM Connect found it at. */
export async function updateReader(
  cloudUrl: string,
  laptopKey: string,
  readerId: number,
  input: { name?: string; hardwareAddress?: string },
): Promise<CloudReader> {
  const base = cloudUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/connector/laptop/readers/${readerId}`, {
    method: "PATCH",
    headers: laptopHeaders(laptopKey, true),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await apiError(res, "Couldn't update the reader");
  return (await res.json()) as CloudReader;
}

/** The club's registered readers. */
export async function fetchReaders(cloudUrl: string, laptopKey: string): Promise<CloudReader[]> {
  const base = cloudUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/connector/laptop/readers`, { headers: laptopHeaders(laptopKey) });
  if (!res.ok) throw await apiError(res, "Couldn't load your readers");
  return (await res.json()) as CloudReader[];
}
