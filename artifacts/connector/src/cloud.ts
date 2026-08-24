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
  hardware: "impinj" | "zebra" | "generic" | "active_transponder" | null;
  connected: boolean;
  detail: string | null;
  lastReadAt: string | null;
  readCount: number;
  antennaIds: number[];
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
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
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
  }): Promise<{ ok: boolean; message?: string }> {
    if (!this.cloudUrl || !this.readerToken) {
      return { ok: false, message: "Cloud link not configured" };
    }
    const payload = JSON.stringify({
      rfidNumber: input.rfidNumber,
      crossingTime: input.crossingTime.toISOString(),
      ...(input.antennaId != null ? { antennaId: input.antennaId } : {}),
    });
    const headers = { "Content-Type": "application/json" };

    const tokenUrl = `${this.cloudUrl}/api/timing/readers/${this.readerToken}/crossing`;
    const res = await fetch(tokenUrl, { method: "POST", headers, body: payload });
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
      return { ok: !!data.ok, message: data.message };
    }

    if (!input.clubId) {
      return { ok: false, message: data.message ?? "No checkpoint assignment and no clubId for facility routing" };
    }
    const facilityUrl = `${this.cloudUrl}/api/timing/active/crossing?clubId=${input.clubId}`;
    const res2 = await fetch(facilityUrl, { method: "POST", headers, body: payload });
    const data2 = (await res2.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: !!data2.ok, message: data2.message ?? data2.error };
  }

  private open(): void {
    if (this.stopped || !this.cloudUrl || !this.readerToken) return;

    const wsUrl =
      this.cloudUrl.replace(/^http/, "ws") +
      `/api/connector/ws?token=${encodeURIComponent(this.readerToken)}`;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.lastError = null;
      this.emit("connected");
      this.sendStatus();
    });

    ws.on("message", (data) => {
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
      this.lastError = err.message;
    });

    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      if (code === 1008 || this.lastError?.includes("401")) {
        this.lastError = "Cloud rejected the reader token — re-select your reader in Settings.";
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

/** Login with organizer credentials; returns the session cookie + clubId. */
export async function cloudLogin(
  cloudUrl: string,
  email: string,
  password: string,
): Promise<{ cookie: string; clubId: number | null }> {
  const base = cloudUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Login failed (${res.status})`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  if (!cookie) throw new Error("Login succeeded but no session cookie was returned");
  const data = (await res.json().catch(() => ({}))) as { clubId?: number; user?: { clubId?: number } };
  const clubId = data.clubId ?? data.user?.clubId ?? null;
  return { cookie, clubId: clubId ?? null };
}

/** Fetch the club's registered readers using a session cookie. */
export async function fetchReaders(cloudUrl: string, cookie: string): Promise<CloudReader[]> {
  const base = cloudUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/readers`, { headers: { Cookie: cookie } });
  if (res.status === 401) throw new Error("Session expired — sign in again");
  if (!res.ok) throw new Error(`Failed to load readers (${res.status})`);
  return (await res.json()) as CloudReader[];
}

