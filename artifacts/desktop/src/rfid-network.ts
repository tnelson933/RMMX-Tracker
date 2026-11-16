import { LlrpClient, impinjHostFromMac } from "./llrp";
import { RecentReadDeduper } from "./recent-read-deduper";

// Direct LLRP connection from the desktop app to a network RFID reader, so
// RFID timing works on a local network with no internet. One RfidNetworkSession
// per reader; this module has no Electron imports.

export type RfidHardware = "impinj" | "zebra" | "generic";

export interface RfidNetworkStatus {
  connected: boolean;
  connecting: boolean;
  reading: boolean;
  hardware: RfidHardware | null;
  host: string | null;
  /**
   * Something that needs attention. Null while the app is still trying to
   * reach the reader: a reader that isn't plugged in is not an error.
   */
  error: string | null;
  /** Why the last attempt failed, while the app keeps retrying. */
  retryReason: string | null;
  lastReadAt: string | null;
  readCount: number;
  antennaIds: number[];
  /** Not connected, and the app is retrying by itself. */
  reconnecting: boolean;
  /** Failed attempts in a row since the reader last answered. */
  failures: number;
  reconnectCountdownMs: number | null;
}

// First retry after 5 seconds, then every 10 (the pace RM Connect uses).
const RECONNECT_DELAYS_MS = [5_000, 10_000];
// Same window RM Connect uses: a reader reports a tag many times per pass.
const DEDUPE_MS = 1_500;

/** Impinj readers can be addressed by the last 6 MAC digits printed on the label. */
export function resolveRfidHost(address: string, kind: RfidHardware): string {
  const trimmed = address.trim();
  if (!trimmed) throw new Error("Enter the reader's IP address or hostname.");
  if (kind === "impinj" && !trimmed.includes(".") && /^[0-9a-fA-F]{6}$/.test(trimmed.replace(/[^0-9a-fA-F]/g, ""))) {
    return impinjHostFromMac(trimmed);
  }
  return trimmed;
}

/** Turns socket and LLRP errors into something an organizer can act on. */
export function friendlyRfidError(error: unknown, host: string): string {
  const err = error as NodeJS.ErrnoException;
  const message = err?.message ?? String(error);
  // A "disconnected" reason arrives as plain text, e.g. "connect ECONNREFUSED 10.0.0.5:5084".
  const code = err?.code ?? /\b(E[A-Z]{4,})\b/.exec(message)?.[1];
  if (code === "ECONNREFUSED") {
    return `The reader at ${host} refused the connection. Turn on its LLRP interface (Impinj: set "RFID interface" to LLRP), and close any other program connected to it.`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Couldn't find ${host} on this network. Check the reader is powered and plugged in, then scan the network again.`;
  }
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || /timed out/i.test(message)) {
    return `No answer from ${host}. Check the reader's power and network cable, and that this computer is on the same network.`;
  }
  if (/another LLRP client|client connection already exists/i.test(message)) {
    return `Another program is already connected to the reader at ${host}. Close it and this app will reconnect.`;
  }
  if (/connection event|LLRP mode/i.test(message)) {
    return `The device at ${host} isn't answering as an RFID reader. Turn on its LLRP interface and try again.`;
  }
  return message;
}

export interface RfidNetworkSessionHandlers {
  onTag?: (epc: string) => void;
  onStatus?: (status: RfidNetworkStatus) => void;
}

/** One LLRP RFID reader: its connection, duplicate filter and retry loop. */
export class RfidNetworkSession {
  private client = new LlrpClient();
  private readonly recentReads = new RecentReadDeduper(DEDUPE_MS);
  private wantedFlag = false;
  private connecting = false;
  private hardware: RfidHardware | null = null;
  private host: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAt: number | null = null;
  private failures = 0;
  private lastFailure: string | null = null;
  /** Bumped by connect()/disconnect() so an attempt still in flight can't reopen the reader. */
  private epoch = 0;
  private readonly onTag: ((epc: string) => void) | undefined;
  private readonly onStatus: ((status: RfidNetworkStatus) => void) | undefined;

  constructor(handlers: RfidNetworkSessionHandlers = {}) {
    this.onTag = handlers.onTag;
    this.onStatus = handlers.onStatus;
    this.wire(this.client);
  }

  private wire(client: LlrpClient): void {
    // A replaced client (the reader was re-pointed while an attempt was still
    // in flight) must not report into this session any more.
    client.on("tag", (read) => {
      if (client !== this.client) return;
      if (this.recentReads.accept(read.epcHex)) this.onTag?.(read.epcHex);
      this.pushStatus();
    });
    client.on("disconnected", (reason: string) => {
      if (client !== this.client) return;
      if (this.wantedFlag && this.host) this.lastFailure = friendlyRfidError(new Error(reason), this.host);
      this.pushStatus();
      this.scheduleReconnect();
    });
    client.on("error", () => { if (client === this.client) this.pushStatus(); });
  }

  get wanted(): boolean {
    return this.wantedFlag;
  }

  /** The address this session is connected to (so a network scan can skip it). */
  connectedHost(): string | null {
    return this.client.getStatus().connected ? this.host : null;
  }

  getStatus(): RfidNetworkStatus {
    const s = this.client.getStatus();
    const reconnecting = this.wantedFlag && !s.connected && !this.connecting;
    const trying = this.wantedFlag && !s.connected;
    return {
      connected: s.connected,
      connecting: this.connecting,
      reading: s.reading,
      hardware: this.hardware,
      host: this.host ?? s.host,
      error: trying ? null : s.connected ? s.error : null,
      retryReason: trying ? this.lastFailure : null,
      lastReadAt: s.lastReadAt,
      readCount: s.readCount,
      antennaIds: s.antennaIds,
      reconnecting,
      failures: this.failures,
      reconnectCountdownMs: this.reconnectAt === null ? null : Math.max(0, this.reconnectAt - Date.now()),
    };
  }

  /**
   * Connects and keeps the reader connected. The promise settles with the
   * first attempt; after a failure the session keeps retrying in the
   * background (as RM Connect does) until disconnect() is called.
   */
  async connect(address: string, kind: RfidHardware): Promise<void> {
    const resolved = resolveRfidHost(address, kind);
    this.disconnect(false);
    if (this.connecting) {
      // An earlier attempt is still in flight on the old client: leave it to
      // close itself and start clean.
      this.client = new LlrpClient();
      this.wire(this.client);
      this.connecting = false;
    }
    this.hardware = kind;
    this.host = resolved;
    this.wantedFlag = true;
    this.failures = 0;
    this.lastFailure = null;
    try {
      await this.openSession();
    } catch (err) {
      this.scheduleReconnect();
      throw new Error(friendlyRfidError(err, resolved));
    }
  }

  disconnect(notify = true): void {
    this.wantedFlag = false;
    this.epoch++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAt = null;
    this.failures = 0;
    this.lastFailure = null;
    void this.client.disconnect().catch(() => {});
    if (notify) this.pushStatus();
  }

  private pushStatus(): void {
    this.onStatus?.(this.getStatus());
  }

  private async openSession(): Promise<void> {
    if (!this.host || !this.hardware) return;
    const epoch = this.epoch;
    const host = this.host;
    const client = this.client;
    this.connecting = true;
    this.pushStatus();
    try {
      await client.connect(host, { impinjExtensions: this.hardware === "impinj" });
      // Disconnected or re-pointed while connecting: let the reader go again
      // (a reader takes only one client).
      if (epoch !== this.epoch) { await client.disconnect().catch(() => {}); return; }
      // Read continuously; the local timing server decides whether a moto or
      // practice is running and rejects reads when timing is idle.
      await client.startReading();
      this.failures = 0;
      this.lastFailure = null;
    } catch (err) {
      // Never leave a half-open connection behind: the next attempt starts clean.
      await client.disconnect().catch(() => {});
      if (epoch === this.epoch) {
        this.failures++;
        this.lastFailure = friendlyRfidError(err, host);
      }
      throw err;
    } finally {
      if (client === this.client) this.connecting = false;
      this.pushStatus();
    }
  }

  private scheduleReconnect(): void {
    if (!this.wantedFlag || this.reconnectTimer || this.connecting) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(Math.max(this.failures - 1, 0), RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAt = null;
      if (!this.wantedFlag) return;
      this.openSession().catch(() => this.scheduleReconnect());
    }, delay);
    this.pushStatus();
  }
}
