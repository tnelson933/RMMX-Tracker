import net from "net";

// F2000 TCP protocol (v3.2). Packets are:
// machineId@cmd@cmdSN@parameters; (normally TCP port 55555).
//
// One ActiveTransponderSession per RM TrackR, so the desktop app can time with
// several readers at once (finish line plus split or section readers). This
// module has no Electron imports: it can be driven from a plain Node script.

export type ActiveTransponderConnectionState =
  | "disconnected"
  | "connecting"
  | "connected_idle"
  | "testing"
  | "race_active"
  | "reconnecting"
  | "error";

export interface ActiveTransponderStatus {
  connected: boolean;
  state: ActiveTransponderConnectionState;
  deviceIp: string | null;
  port: number | null;
  machineId: string | null;
  /**
   * Something that needs attention. Null while the app is still trying to
   * reach a reader (connecting or retrying): a reader that isn't plugged in
   * is not an error. The reason for a retry is in `retryReason`.
   */
  error: string | null;
  /** Why the last connection attempt failed, while the app keeps retrying. */
  retryReason: string | null;
  diagnosis: string;
  lastPassingAt: string | null;
  /** Preferred name for new consumers; lastPassingAt remains for compatibility. */
  lastCrossingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  /** False once the RM TrackR stopped sending heartbeats (older than 5 s). */
  heartbeatFresh: boolean;
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
  /** The last replay of reads missed during a dropout, if any. */
  lastReplay: ActiveTransponderReplay | null;
}

export interface ActiveTransponderReplay {
  /** When the app asked the RM TrackR for the missed reads. */
  requestedAt: string;
  /** The gap that was replayed (this computer's time). */
  from: string;
  to: string;
  /** Reads the RM TrackR resent for that gap so far. */
  reads: number;
}

export interface ActiveTransponderConfiguration {
  activeChannel: number;
  activePower: number;
  loopEnabled: [boolean, boolean];
}

export interface ActiveTransponderPassingMetadata {
  /** UTC receipt captured at the TCP socket data event, before any HTTP queueing. */
  /** When this computer received a live read. Left out for reads resent after a dropout. */
  receivedAtUtc?: string;
  /** Host IANA zone used while parsing the F2000's local wall-clock timestamp. */
  deviceTimezone: string;
  /**
   * f2000_tcp: read live. f2000_rewind: resent by the RM TrackR after a
   * dropout; its time is when it was read, so the local server must not
   * replace it with the (late) receipt.
   */
  source: "f2000_tcp" | "f2000_rewind";
  timeSource: "f2000_device";
}

export type ActiveTransponderPassingCallback = (
  epc: string,
  crossingTime: Date,
  metadata: ActiveTransponderPassingMetadata,
) => void;
export type ActiveTransponderStatusCallback = (status: ActiveTransponderStatus) => void;

const ACTIVE_TRANSPONDER_PORT = 55555;
const CONNECT_TIMEOUT_MS = 8_000;
// A dropped reader is retried quickly first (a wiggled cable mid-race), then
// every 10 seconds for as long as it stays away.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
const HEARTBEAT_TIMEOUT_MS = 15_000;
// Same limit RM Connect uses: a heartbeat older than this means not ready.
const HEARTBEAT_STALE_MS = 5_000;
const HEALTH_CHECK_INTERVAL_MS = 1_000;
// Reopen the connection only after this long with nothing at all from the reader.
// RM Connect never forces it; a reader pausing while it applies settings (or
// heartbeating slowly) must not be caught in a reconnect loop.
const SILENT_RECONNECT_MS = 15_000;
const READER_OPEN_RETRY_MS = 2_000;
// Replay after a dropout: ask from a little before the last contact (reads
// already recorded are rejected as duplicates), expect the resent reads within
// a couple of minutes, and never ask for more than a race day.
const REPLAY_OVERLAP_MS = 30_000;
const REPLAY_WINDOW_MS = 2 * 60_000;
const MAX_REPLAY_SPAN_MS = 12 * 60 * 60 * 1000;
// readerOpen has no acknowledgement: re-send it a few times, then stop.
const MAX_READER_OPEN_ATTEMPTS = 6;
// As in RM Connect: the RM TrackR can ignore readerOpen while it applies settings,
// so every few unanswered attempts re-send the settings and open on the next try.
const FULL_CONFIGURATION_RETRY_INTERVAL = 5;
export const DEFAULT_ACTIVE_TRANSPONDER_CONFIGURATION: ActiveTransponderConfiguration = {
  activeChannel: 0,
  activePower: 100,
  loopEnabled: [true, true],
};

export function normalizeActiveTransponderAddress(address: string): { host: string; port: number; address: string } {
  const value = address.trim();
  if (!value) throw new Error("Enter an RM TrackR IP address or hostname.");
  // Bracketed IPv6 is accepted; unbracketed IPv6 uses the default port.
  const bracketed = /^\[([^\]]+)\](?::(.+))?$/.exec(value);
  const colon = value.lastIndexOf(":");
  const hasSingleColonPort = colon > 0 && value.indexOf(":") === colon;
  const host = bracketed ? bracketed[1] : hasSingleColonPort ? value.slice(0, colon) : value;
  const portText = bracketed ? bracketed[2] : hasSingleColonPort ? value.slice(colon + 1) : undefined;
  if (!host) throw new Error("Enter an RM TrackR IP address or hostname.");
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) throw new Error("RM TrackR port must be a number between 1 and 65535.");
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("RM TrackR port must be between 1 and 65535.");
    }
    return { host, port, address: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}` };
  }
  return { host, port: ACTIVE_TRANSPONDER_PORT, address: host };
}

export function formatActiveTransponderLocalClock(now = new Date()): { date: string; time: string } {
  const two = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`,
    time: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${two(Math.floor(now.getMilliseconds() / 10))}`,
  };
}

/** "2026-6-30_17:34:25.333": the RM TrackR's local wall-clock format (rewindData and epc). */
export function formatF2000DeviceTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}_${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function getHostIanaTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function validateActiveTransponderConfiguration(config: ActiveTransponderConfiguration): void {
  if (!config || typeof config !== "object") {
    throw new Error("RM TrackR settings are missing.");
  }
  if (!Number.isInteger(config.activeChannel) || config.activeChannel < 0 || config.activeChannel > 5) {
    throw new Error("RM TrackR active channel must be an integer from 0 to 5.");
  }
  if (!Number.isInteger(config.activePower) || config.activePower < 0 || config.activePower > 100) {
    throw new Error("RM TrackR active power must be an integer from 0 to 100.");
  }
  if (!Array.isArray(config.loopEnabled) || config.loopEnabled.length !== 2 || config.loopEnabled.some((value) => typeof value !== "boolean")) {
    throw new Error("RM TrackR loop settings must specify enabled/disabled values for loops 1 and 2.");
  }
}

function parseOptionalNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed;
}

/** The RM TrackR's local wall-clock timestamp as a Date, with no skew clamp (null if malformed). */
function parseF2000WallTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms = "0"] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, "0")));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseF2000Timestamp(value: string, receivedAt: Date): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms = "0"] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, "0")));
  const matchesWallTime = (candidate: Date) => !Number.isNaN(candidate.getTime())
    && candidate.getFullYear() === Number(y) && candidate.getMonth() === Number(mo) - 1 && candidate.getDate() === Number(d)
    && candidate.getHours() === Number(h) && candidate.getMinutes() === Number(mi) && candidate.getSeconds() === Number(s);
  // Same as RM Connect: a spring-forward wall time doesn't exist; a fall-back one
  // happens twice, so take the occurrence nearest the socket receipt.
  if (!matchesWallTime(date)) return receivedAt;
  const candidates = [date];
  for (const offset of [-2, -1, 1, 2]) {
    const alternative = new Date(date.getTime() + offset * 60 * 60 * 1000);
    if (matchesWallTime(alternative)) candidates.push(alternative);
  }
  const nearest = candidates.reduce((best, c) =>
    Math.abs(c.getTime() - receivedAt.getTime()) < Math.abs(best.getTime() - receivedAt.getTime()) ? c : best);
  return Math.abs(nearest.getTime() - receivedAt.getTime()) > 5 * 60 * 1000 ? receivedAt : nearest;
}

// Same test as RM Connect (artifacts/connector/src/active-transponder-client.ts,
// isLoopWorking): firmware reports values such as "1", "running" or "working".
function isWorking(value: string | null): boolean {
  if (value === null) return false;
  return /^(1|true|enabled)$/i.test(value.trim()) || /working|running|open/i.test(value);
}

export interface ActiveTransponderSessionHandlers {
  onPassing?: ActiveTransponderPassingCallback;
  onStatus?: ActiveTransponderStatusCallback;
}

/** One RM TrackR: its TCP connection, loop state, dropout replay and status. */
export class ActiveTransponderSession {
  private socket: net.Socket | null = null;
  private deviceIp: string | null = null;
  private targetPort: number | null = null;
  private machineId: string | null = null;
  private lastPassingAt: string | null = null;
  private passingCount = 0;
  private lastHeartbeatAt: string | null = null;
  private lastHeartbeatMs: number | null = null;
  private heartbeatStale = false;
  private batteryPercent: number | null = null;
  private totalTagsRead: number | null = null;
  private differentTagsRead: number | null = null;
  // A transponder pass after the loops were opened proves they run, whatever the
  // loop telemetry says (some RM TrackR firmware never reports it).
  private loopsProvenByReads = false;
  private readerOpenAttempts = 0;
  /** readerStop was sent and no readerOpen or new settings since. */
  private readersStopSent = false;
  private reader1Working: string | null = null;
  private reader2Working: string | null = null;
  private eventId: string | null = null;
  private connectError: string | null = null;
  /** The last read the local server couldn't record; cleared by the next read. */
  private postError: string | null = null;
  private recvBuffer = "";
  private commandSerialNumber = 0;
  private reader1State: "open" | "closed" | "unknown" = "unknown";
  private reader2State: "open" | "closed" | "unknown" = "unknown";
  private readonly statusCallback: ActiveTransponderStatusCallback | undefined;
  private readonly passingCallback: ActiveTransponderPassingCallback | undefined;
  private desiredConnected = false;
  private localReaderActive = false;
  private testActive = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAt: number | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private connectingSocket: net.Socket | null = null;
  private targetHost: string | null = null;
  private connectionEpoch = 0;
  private connectionAttempt = 0;
  private reconnectAttempt = 0;
  private configuration: ActiveTransponderConfiguration = {
    ...DEFAULT_ACTIVE_TRANSPONDER_CONFIGURATION,
    loopEnabled: [...DEFAULT_ACTIVE_TRANSPONDER_CONFIGURATION.loopEnabled],
  };
  private configApplied = false;
  private lastReaderOpenRequestAt = 0;
  // Replay after a dropout. The RM TrackR keeps reading and storing while the
  // network is down; on reconnect the app asks it to resend that window.
  private lastContactAt: number | null = null;
  /** RM TrackR clock minus this computer's, from the last live read. */
  private deviceOffsetMs = 0;
  /** This computer's time the current gap started (earliest, across retries). */
  private gapStartedAt: number | null = null;
  private replay: { fromDeviceMs: number; untilDeviceMs: number; offsetMs: number; expiresAt: number } | null = null;
  private lastReplay: ActiveTransponderReplay | null = null;
  private readonly intentionallyDisconnectedSockets = new WeakSet<net.Socket>();

  constructor(handlers: ActiveTransponderSessionHandlers = {}) {
    this.passingCallback = handlers.onPassing;
    this.statusCallback = handlers.onStatus;
  }

  getStatus(): ActiveTransponderStatus {
    const connected = !!this.socket && !this.socket.destroyed;
    const state = this.getState(connected);
    const loopsReady = this.areEnabledLoopsTelemetryReady();
    const trying = state === "connecting" || state === "reconnecting";
    return {
      connected,
      state,
      deviceIp: this.deviceIp,
      port: this.targetPort,
      machineId: this.machineId,
      error: trying ? null : this.connectError ?? this.postError,
      retryReason: trying ? this.connectError : null,
      diagnosis: this.getDiagnosis(state),
      lastPassingAt: this.lastPassingAt,
      lastCrossingAt: this.lastPassingAt,
      passingCount: this.passingCount,
      lastHeartbeatAt: this.lastHeartbeatAt,
      heartbeatFresh: connected && this.lastHeartbeatMs !== null && !this.heartbeatStale,
      reconnectAttempt: this.reconnectAttempt,
      reconnectCountdownMs: this.reconnectAt === null ? null : Math.max(0, this.reconnectAt - Date.now()),
      configApplied: this.configApplied,
      loopsReady,
      loopsReading: this.loopsProvenByReads,
      // Ready once configured and the enabled loops were opened. Loop telemetry
      // doesn't gate it: some RM TrackR firmware reports a loop as 0 (off) while
      // it reads. A transponder pass is the proof. A stopped heartbeat means the
      // reader can't be trusted to be reading.
      ready: this.configApplied && this.lastHeartbeatMs !== null && !this.heartbeatStale && (!this.readersShouldBeOpen() || this.enabledLoopsOpened()),
      activeChannel: this.configuration.activeChannel,
      activePower: this.configuration.activePower,
      loopEnabled: [...this.configuration.loopEnabled] as [boolean, boolean],
      reader1State: this.reader1State,
      reader2State: this.reader2State,
      batteryPercent: this.batteryPercent,
      totalTagsRead: this.totalTagsRead,
      differentTagsRead: this.differentTagsRead,
      reader1Working: this.reader1Working,
      reader2Working: this.reader2Working,
      eventId: this.eventId,
      lastReplay: this.lastReplay ? { ...this.lastReplay } : null,
    };
  }

  /** The address this session is connected to (so a network scan can skip it). */
  connectedHost(): string | null {
    return this.socket && !this.socket.destroyed ? this.deviceIp : null;
  }

  /** True between connect() and disconnect(), whether or not the reader answers. */
  get wanted(): boolean {
    return this.desiredConnected;
  }

  /**
   * Connects and keeps the reader connected. The promise settles with the
   * first attempt; after a failure the session keeps retrying in the
   * background until disconnect() is called.
   *
   * `sameDevice`: the reader was found at a new address (the router gave it
   * another one), so reads from the gap are still replayed.
   */
  connect(address: string, options: { sameDevice?: boolean } = {}): Promise<void> {
    const { host, port } = normalizeActiveTransponderAddress(address);
    // Reconnecting to the same reader replays from the dropout (or, for a
    // connection that froze without closing, from the last contact).
    const sameReader = options.sameDevice || (host === this.targetHost && port === this.targetPort);
    const pendingGap = sameReader ? this.gapStartedAt ?? this.lastContactAt : null;
    const pendingContact = sameReader ? this.lastContactAt : null;
    this.disconnect(false);
    this.gapStartedAt = pendingGap;
    this.lastContactAt = pendingContact;
    this.resetConnectionState();
    this.deviceIp = host;
    this.targetPort = port;
    this.desiredConnected = true;
    this.targetHost = host;
    const epoch = ++this.connectionEpoch;
    this.notifyStatus();
    return this.createConnection(host, port, epoch, true);
  }

  disconnect(notify = true): void {
    this.desiredConnected = false;
    // A deliberate disconnect isn't a dropout: nothing to replay.
    this.gapStartedAt = null;
    this.replay = null;
    this.testActive = false;
    this.connectionEpoch++;
    this.clearReconnectTimer();
    this.clearHealthWatch();
    this.stopReaders(true);
    for (const connection of [this.socket, this.connectingSocket]) {
      if (connection && !connection.destroyed) {
        this.intentionallyDisconnectedSockets.add(connection);
        connection.end();
        connection.destroy();
      }
    }
    this.socket = null;
    this.connectingSocket = null;
    this.targetHost = null;
    this.targetPort = null;
    this.resetConnectionState();
    if (notify) this.notifyStatus();
  }

  /**
   * Called from the local reader-state poll. Its state always remains
   * authoritative for racing, and it is kept across reconnects.
   */
  setReading(reading: boolean): void {
    this.localReaderActive = reading;
    this.syncReaders();
    this.notifyStatus();
  }

  configure(config: ActiveTransponderConfiguration): void {
    validateActiveTransponderConfiguration(config);
    this.configuration = {
      activeChannel: config.activeChannel,
      activePower: config.activePower,
      loopEnabled: [...config.loopEnabled] as [boolean, boolean],
    };
    this.configApplied = false;
    if (this.socket && !this.socket.destroyed && this.machineId) {
      // Reconfigure safely: close readers, set all device parameters, then reopen
      // only the enabled loops if local race/test state still requires them.
      this.stopReaders(true);
      this.applyConfiguration();
    }
    this.notifyStatus();
  }

  /** Synchronizes the F2000's local clock using separate V3.2 date/time commands. */
  syncClock(): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) {
      throw new Error("Connect to the RM TrackR and wait for its machine ID before syncing its clock.");
    }
    this.sendClockCommands();
    this.notifyStatus();
  }

  /** Opens both loops for a hardware test. A crossing is only reported when the F2000 actually sends one. */
  startTest(): void {
    if (!this.desiredConnected) throw new Error("Connect to the RM TrackR before starting a loop test.");
    this.testActive = true;
    this.connectError = null;
    this.syncReaders();
    this.notifyStatus();
  }

  stopTest(): void {
    this.testActive = false;
    this.syncReaders();
    this.notifyStatus();
  }

  /** Lets the owner surface a rejected real crossing (for example, a server failure). */
  reportError(message: string): void {
    // Shown as the reader's error, but it isn't a connection problem: the reader
    // stays connected and reading (the state doesn't turn to "error").
    this.postError = message;
    this.notifyStatus();
  }

  private createConnection(host: string, port: number, epoch: number, reportInitialResult: boolean): Promise<void> {
    const attempt = ++this.connectionAttempt;
    const connection = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
    this.connectingSocket = connection;
    let connected = false;
    let settled = false;
    const isCurrent = () => this.desiredConnected && this.connectionEpoch === epoch && this.connectionAttempt === attempt;

    return new Promise((resolve, reject) => {
      const failInitial = (error: Error) => {
        if (reportInitialResult && !settled) { settled = true; reject(error); }
      };
      connection.once("connect", () => {
        if (!isCurrent()) { this.intentionallyDisconnectedSockets.add(connection); connection.destroy(); return; }
        connected = true; settled = true;
        if (this.connectingSocket === connection) this.connectingSocket = null;
        this.socket = connection;
        connection.setNoDelay(true);
        connection.setKeepAlive(true, 1_000);
        connection.setTimeout(0);
        this.connectError = null;
        this.reconnectAttempt = 0;
        this.reconnectAt = null;
        this.armHeartbeatWatch();
        this.armHealthWatch();
        this.syncReaders();
        this.notifyStatus();
        if (reportInitialResult) resolve();
      });
      connection.once("timeout", () => {
        if (!isCurrent()) return;
        const error = new Error(`Connection to ${host}:${port} timed out. Check the RM TrackR address, power, Ethernet/Wi-Fi network, and port ${port}.`);
        this.connectError = error.message;
        connection.destroy();
        this.notifyStatus();
        if (!connected) failInitial(error);
      });
      connection.on("data", (chunk: Buffer) => {
        if (!isCurrent() || this.socket !== connection) return;
        this.recvBuffer += chunk.toString("utf8");
        this.processPackets(new Date());
      });
      connection.on("error", (error) => {
        if (!isCurrent()) return;
        this.connectError = `RM TrackR network error at ${host}:${port}: ${error.message}`;
        this.notifyStatus();
        if (!connected) failInitial(new Error(this.connectError));
      });
      connection.on("close", () => {
        if (this.socket === connection) this.socket = null;
        if (this.connectingSocket === connection) this.connectingSocket = null;
        if (!isCurrent()) { if (!connected) failInitial(new Error("Connection attempt cancelled.")); return; }
        this.clearHeartbeatWatch();
        this.clearHealthWatch();
        // Reads during the gap stay on the RM TrackR: replay them on reconnect.
        if (!this.intentionallyDisconnectedSockets.has(connection) && this.lastContactAt !== null && this.gapStartedAt === null) this.gapStartedAt = this.lastContactAt;
        if (!this.intentionallyDisconnectedSockets.has(connection) && !this.connectError) this.connectError = "RM TrackR disconnected unexpectedly. Reconnecting…";
        this.clearDeviceSessionState();
        // Schedule the retry before reporting, so a reader that is simply not
        // there shows as retrying and never flashes an error.
        this.scheduleReconnect();
        this.notifyStatus();
        if (!connected) failInitial(new Error(this.connectError ?? "Connection closed before it could be established."));
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.desiredConnected || !this.targetHost || this.targetPort === null || this.reconnectTimer || (this.connectingSocket && !this.connectingSocket.destroyed)) return;
    const host = this.targetHost, port = this.targetPort, epoch = this.connectionEpoch;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null; this.reconnectAt = null;
      if (!this.desiredConnected || this.connectionEpoch !== epoch || (this.socket && !this.socket.destroyed) || (this.connectingSocket && !this.connectingSocket.destroyed)) return;
      void this.createConnection(host, port, epoch, false);
      this.notifyStatus();
    }, delay);
    this.notifyStatus();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null; this.reconnectAt = null;
  }

  private armHeartbeatWatch(): void {
    this.clearHeartbeatWatch();
    this.heartbeatTimer = setTimeout(() => {
      if (this.socket && !this.socket.destroyed && !this.lastHeartbeatAt) {
        this.connectError = `No RM TrackR heartbeat was received within ${HEARTBEAT_TIMEOUT_MS / 1000} seconds. Check the selected address and device network.`;
        this.notifyStatus();
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeatWatch(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /**
   * After the first heartbeat, a reader that goes quiet is not ready. A pulled
   * cable or a frozen reader can leave the TCP connection open for minutes, so
   * once nothing at all has arrived for the same time, the connection is
   * reopened; the reconnect asks the reader to resend what was missed.
   */
  private armHealthWatch(): void {
    this.clearHealthWatch();
    this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_INTERVAL_MS);
  }

  private clearHealthWatch(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private checkHealth(): void {
    const connection = this.socket;
    if (!connection || connection.destroyed || this.lastHeartbeatMs === null) return;
    const now = Date.now();
    const stale = now - this.lastHeartbeatMs > HEARTBEAT_STALE_MS;
    if (stale !== this.heartbeatStale) {
      this.heartbeatStale = stale;
      this.notifyStatus();
    }
    if (stale && this.lastContactAt !== null && now - this.lastContactAt > SILENT_RECONNECT_MS) {
      this.connectError = "RM TrackR heartbeat stopped. Reconnecting…";
      connection.destroy();
    }
  }

  private resetConnectionState(): void {
    this.deviceIp = null; this.targetPort = null; this.reconnectAttempt = 0; this.clearHeartbeatWatch(); this.clearDeviceSessionState(); this.connectError = null;
  }

  private clearDeviceSessionState(): void {
    this.machineId = null; this.lastPassingAt = null; this.passingCount = 0; this.lastHeartbeatAt = null;
    this.lastHeartbeatMs = null; this.heartbeatStale = false;
    this.batteryPercent = null; this.totalTagsRead = null; this.differentTagsRead = null; this.reader1Working = null; this.reader2Working = null;
    this.eventId = null; this.recvBuffer = ""; this.commandSerialNumber = 0; this.reader1State = "unknown"; this.reader2State = "unknown"; this.configApplied = false; this.lastReaderOpenRequestAt = 0;
    this.loopsProvenByReads = false;
    this.readerOpenAttempts = 0;
    this.readersStopSent = false;
  }

  private processPackets(receivedAt: Date): void {
    let delimiterIndex: number;
    while ((delimiterIndex = this.recvBuffer.indexOf(";")) >= 0) {
      const packet = this.recvBuffer.slice(0, delimiterIndex).trim(); this.recvBuffer = this.recvBuffer.slice(delimiterIndex + 1);
      if (packet) this.processPacket(packet, receivedAt);
    }
  }

  private processPacket(packet: string, receivedAt: Date): void {
    const parts = packet.split("@");
    // Three fields are enough (RM Connect accepts "id@heartBeat@0001" with no parameters).
    if (parts.length < 3) return;
    const [packetMachineId, command, , ...parameterParts] = parts;
    if (!packetMachineId || !command) return;
    this.lastContactAt = receivedAt.getTime();
    if (this.machineId !== packetMachineId) {
      // First packet, or a different RM TrackR answering at this address: set it up from scratch.
      const firstPacket = this.machineId === null;
      this.machineId = packetMachineId;
      this.applyConfiguration();
      if (firstPacket) this.requestReplay(receivedAt);
    }
    const parameters = parameterParts.join("@");
    if (command === "epc") this.processEpc(parameters, receivedAt);
    else if (command === "heartBeat") {
      this.lastHeartbeatAt = new Date().toISOString();
      this.lastHeartbeatMs = Date.now();
      this.heartbeatStale = false;
      if (this.connectError?.startsWith("No RM TrackR heartbeat")) this.connectError = null;
      this.armHeartbeatWatch();
    }
    else if (command === "machineState") this.processMachineState(parameters);
    // An F2000 can ignore readerOpen while it is applying configuration. Keep
    // retrying after device packets until loop telemetry confirms it is working.
    this.syncReaders();
    this.notifyStatus();
  }

  private processEpc(parameters: string, receivedAt: Date): void {
    const commaIndex = parameters.indexOf(",");
    if (commaIndex < 1) return;
    const stamp = parameters.slice(0, commaIndex).trim();
    const epc = parameters.slice(commaIndex + 1).trim();
    const deviceTime = parseF2000WallTime(stamp);
    const activeReplay = this.replay && receivedAt.getTime() <= this.replay.expiresAt ? this.replay : null;
    if (epc && deviceTime && activeReplay
      && deviceTime.getTime() >= activeReplay.fromDeviceMs && deviceTime.getTime() <= activeReplay.untilDeviceMs) {
      // Resent from the dropout: keep the moment it was read (this computer's
      // time), never the moment it arrived.
      if (this.lastReplay) this.lastReplay.reads++;
      // No receipt time on a resent read (same as RM Connect): the timing server
      // would take a read from more than 5 minutes ago for clock skew and
      // re-stamp it with the arrival time.
      this.passingCallback?.(epc, new Date(deviceTime.getTime() - activeReplay.offsetMs), {
        deviceTimezone: getHostIanaTimezone(),
        source: "f2000_rewind",
        timeSource: "f2000_device",
      });
      return;
    }
    if (deviceTime && Math.abs(deviceTime.getTime() - receivedAt.getTime()) < 24 * 60 * 60 * 1000) {
      this.deviceOffsetMs = deviceTime.getTime() - receivedAt.getTime();
    }
    const timestamp = parseF2000Timestamp(stamp, receivedAt);
    if (!timestamp || !epc) return;
    this.lastPassingAt = timestamp.toISOString(); this.passingCount++; this.connectError = null; this.postError = null;
    // Reading works: stop re-sending readerOpen, which can briefly interrupt loops.
    if (this.reader1State === "open" || this.reader2State === "open") this.loopsProvenByReads = true;
    this.passingCallback?.(epc, timestamp, {
      receivedAtUtc: receivedAt.toISOString(),
      deviceTimezone: getHostIanaTimezone(),
      source: "f2000_tcp",
      timeSource: "f2000_device",
    });
  }

  private processMachineState(parameters: string): void {
    const values = new Map<string, string>();
    for (const item of parameters.split(",")) {
      const separator = item.indexOf("="); if (separator > 0) values.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
    const previous1 = this.reader1Working, previous2 = this.reader2Working;
    this.batteryPercent = parseOptionalNumber(values.get("batteryPercent")); this.totalTagsRead = parseOptionalNumber(values.get("totalTagsRead"));
    this.differentTagsRead = parseOptionalNumber(values.get("differentTagsRead")); this.reader1Working = values.get("reader1Working") ?? null;
    this.reader2Working = values.get("reader2Working") ?? null; this.eventId = values.get("eventId") ?? null;

    // A loop the reader said was working and now reports as stopped was closed on
    // the reader's side (a restart, a settings change, a hiccup). Open it again,
    // even after a pass proved the loops: otherwise reading stops for the rest of
    // the session. Only a change counts, so firmware that always reports a loop as
    // 0 while it reads (see getStatus) is left alone.
    const dropped = (enabled: boolean, before: string | null, now: string | null) =>
      enabled && isWorking(before) && now !== null && !isWorking(now);
    const loop1Dropped = dropped(this.configuration.loopEnabled[0], previous1, this.reader1Working);
    const loop2Dropped = dropped(this.configuration.loopEnabled[1], previous2, this.reader2Working);
    if ((loop1Dropped || loop2Dropped) && this.readersShouldBeOpen()) {
      if (loop1Dropped) this.reader1State = "closed";
      if (loop2Dropped) this.reader2State = "closed";
      this.loopsProvenByReads = false;
      this.readerOpenAttempts = 0;
      this.lastReaderOpenRequestAt = 0;
    }
  }

  /**
   * After a dropout, ask the RM TrackR to resend what it read while this app
   * couldn't hear it (rewindData). The window starts a little before the last
   * contact; reads that did get through are rejected as duplicates.
   */
  private requestReplay(now: Date): void {
    if (this.gapStartedAt === null) return;
    const nowMs = now.getTime();
    const fromMs = Math.max(this.gapStartedAt - REPLAY_OVERLAP_MS, nowMs - MAX_REPLAY_SPAN_MS);
    const offsetMs = this.deviceOffsetMs;
    this.gapStartedAt = null;
    if (nowMs <= fromMs) return;
    this.replay = { fromDeviceMs: fromMs + offsetMs, untilDeviceMs: nowMs + offsetMs, offsetMs, expiresAt: nowMs + REPLAY_WINDOW_MS };
    this.lastReplay = { requestedAt: now.toISOString(), from: new Date(fromMs).toISOString(), to: now.toISOString(), reads: 0 };
    this.sendCommand("rewindData", `${formatF2000DeviceTime(fromMs + offsetMs)},${formatF2000DeviceTime(nowMs + offsetMs)}`);
  }

  /**
   * Loops stay open whenever the RM TrackR is connected, as in RM Connect
   * (reader-session.ts starts reading on every connect). The local server decides
   * which reads count (it answers 404/409 when nothing is running). Opening loops
   * only while a moto runs lost the start of each moto to the 1 s state poll and
   * readerOpen settle time, and left the loops shut if the poll failed: the
   * RM TrackR then never recorded the crossing, so even a replay couldn't bring it back.
   */
  private readersShouldBeOpen(): boolean { return this.desiredConnected; }

  private syncReaders(): void {
    if (this.readersShouldBeOpen()) this.openReaders(); else this.stopReaders();
    if (this.desiredConnected && (!this.socket || this.socket.destroyed) && (!this.connectingSocket || this.connectingSocket.destroyed)) this.scheduleReconnect();
  }

  private openReaders(): void {
    if (!this.socket || this.socket.destroyed || !this.machineId || !this.configApplied) return;
    const loopEnabled = this.configuration.loopEnabled;
    const shouldRetry = Date.now() - this.lastReaderOpenRequestAt >= READER_OPEN_RETRY_MS;
    const needsReader1 = loopEnabled[0] && (this.reader1State !== "open" || !isWorking(this.reader1Working));
    const needsReader2 = loopEnabled[1] && (this.reader2State !== "open" || !isWorking(this.reader2Working));
    if (!needsReader1 && !needsReader2) return;
    if (this.loopsProvenByReads
      && (!loopEnabled[0] || this.reader1State === "open")
      && (!loopEnabled[1] || this.reader2State === "open")) return;
    if (!shouldRetry && this.reader1State === "open" && this.reader2State === "open") return;
    if (this.enabledLoopsOpened() && this.readerOpenAttempts >= MAX_READER_OPEN_ATTEMPTS) return;
    this.readerOpenAttempts++;
    if (this.readerOpenAttempts > 1 && (this.readerOpenAttempts - 1) % FULL_CONFIGURATION_RETRY_INTERVAL === 0) {
      // Settings reset the loops to stopped: mark them closed so the next retry opens them.
      this.sendDeviceSettings();
      this.reader1State = "closed";
      this.reader2State = "closed";
      this.lastReaderOpenRequestAt = Date.now();
      return;
    }
    this.readersStopSent = false;
    if (needsReader1) {
      this.sendReaderCommand("readerOpen", 1); this.reader1State = "open";
    }
    if (needsReader2) {
      this.sendReaderCommand("readerOpen", 2); this.reader2State = "open";
    }
    this.lastReaderOpenRequestAt = Date.now();
  }

  /**
   * Closes both loops. Sent once per change, like RM Connect: syncReaders runs on
   * every packet, and re-sending readerStop with each heartbeat floods the reader.
   */
  private stopReaders(force = false): void {
    if (!force && this.readersStopSent) return;
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    this.sendReaderCommand("readerStop", 1); this.sendReaderCommand("readerStop", 2); this.reader1State = "closed"; this.reader2State = "closed"; this.lastReaderOpenRequestAt = 0;
    this.readersStopSent = true;
  }

  private sendReaderCommand(command: "readerOpen" | "readerStop", reader: 1 | 2): void {
    this.sendCommand(command, String(reader));
  }

  private sendCommand(command: string, parameters: string): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    const serial = String(this.commandSerialNumber++ % 10_000).padStart(4, "0");
    this.socket.write(`${this.machineId}@${command}@${serial}@${parameters};`);
  }

  private sendClockCommands(): void {
    const { date, time } = formatActiveTransponderLocalClock();
    this.sendCommand("setDate", date);
    this.sendCommand("setTime", time);
  }

  private applyConfiguration(): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    // Clock and settings must precede readerOpen and any first-packet crossing.
    this.sendClockCommands();
    this.sendDeviceSettings();
    this.configApplied = true;
    this.loopsProvenByReads = false;
    this.readerOpenAttempts = 0;
    this.readersStopSent = false;
    this.reader1State = "closed";
    this.reader2State = "closed";
    this.lastReaderOpenRequestAt = 0;
    this.syncReaders();
  }

  /** Channel and power before loop enable/disable (the order the RM TrackR needs). */
  private sendDeviceSettings(): void {
    this.sendCommand("setActiveChannel", String(this.configuration.activeChannel));
    this.sendCommand("setActivePower", String(this.configuration.activePower));
    this.sendCommand(this.configuration.loopEnabled[0] ? "loopEnable" : "loopDisable", "1");
    this.sendCommand(this.configuration.loopEnabled[1] ? "loopEnable" : "loopDisable", "2");
  }

  private enabledLoopsOpened(): boolean {
    return (!this.configuration.loopEnabled[0] || this.reader1State === "open") && (!this.configuration.loopEnabled[1] || this.reader2State === "open");
  }

  private areEnabledLoopsTelemetryReady(): boolean {
    if (this.loopsProvenByReads) return true;
    return (!this.configuration.loopEnabled[0] || (this.reader1State === "open" && isWorking(this.reader1Working))) &&
      (!this.configuration.loopEnabled[1] || (this.reader2State === "open" && isWorking(this.reader2Working)));
  }

  private getState(connected: boolean): ActiveTransponderConnectionState {
    if (!this.desiredConnected) return "disconnected";
    if (this.connectError && !connected && !this.connectingSocket && !this.reconnectTimer) return "error";
    if (this.reconnectTimer || (this.connectingSocket && this.reconnectAttempt > 0)) return "reconnecting";
    if (this.connectingSocket) return "connecting";
    if (this.connectError) return "error";
    if (this.testActive) return "testing";
    if (this.localReaderActive) return "race_active";
    return connected ? "connected_idle" : "connecting";
  }

  private getDiagnosis(state: ActiveTransponderConnectionState): string {
    if (state === "disconnected") return "Disconnected. Enter the RM TrackR address (port 55555 is used when no port is supplied).";
    if (state === "connecting") return "Connecting to the RM TrackR. Waiting for its first heartbeat to identify the machine.";
    if (state === "reconnecting") return `Not connected; retry ${this.reconnectAttempt} is scheduled. Reading resumes by itself once the RM TrackR answers.`;
    if (state === "error") return this.connectError ?? "RM TrackR requires attention. Check its address, network, and heartbeat.";
    if (!this.machineId) return "TCP connected; waiting for the RM TrackR heartbeat before loop settings can be applied.";
    if (this.heartbeatStale) return "RM TrackR heartbeat stopped. Check the reader and its network connection.";
    if (!this.configApplied) return "RM TrackR is not ready: applying saved loop, channel, and power settings.";
    if (this.postError) return this.postError;
    if (this.readersShouldBeOpen() && !this.loopsProvenByReads && !this.areEnabledLoopsTelemetryReady()) return "Ready. The first transponder pass confirms the loop is reading.";
    if (state === "testing") return this.lastPassingAt ? "Both loops are open for testing; a real RM TrackR crossing was observed." : "Both loops are open for testing. Pass a tagged transponder over a loop to verify it.";
    if (state === "race_active") return "A moto or practice is running; the RM TrackR loops are open and reads are being timed.";
    return "Connected; the loops are open. Reads are timed once a moto or practice starts.";
  }

  private notifyStatus(): void { this.statusCallback?.(this.getStatus()); }
}
