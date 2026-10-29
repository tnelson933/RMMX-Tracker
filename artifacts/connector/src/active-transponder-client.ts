/**
 * F2000 active-transponder client.
 *
 * The V3.2 socket protocol is UTF-8 text framed by semicolons:
 * machineId@cmd@cmdSN@parameters;
 */
import net from "net";
import { EventEmitter } from "events";

const F2000_PORT = 55555;
const CONNECT_TIMEOUT_MS = 8_000;
const HEARTBEAT_STALE_MS = 5_000;
const READER_OPEN_RETRY_MS = 2_000;
const FULL_CONFIGURATION_RETRY_INTERVAL = 5;
// readerOpen has no acknowledgement and some firmware never reports a loop as
// running, so stop re-sending it after a few tries (about 12 s).
const MAX_READER_OPEN_RETRIES = 6;
export const MAX_DIRECT_CLOCK_SKEW_MS = 5 * 60 * 1000;
// Replay after a dropout: ask from a little before the last contact (reads
// already delivered are rejected as duplicates by RM Roost), expect the resent
// reads within a couple of minutes, and never ask for more than a race day.
const REPLAY_OVERLAP_MS = 30_000;
const REPLAY_WINDOW_MS = 2 * 60_000;
const MAX_REPLAY_SPAN_MS = 12 * 60 * 60 * 1000;

export interface ActiveTimingReceiptMetadata {
  /** Socket receipt of a live read; null for a read the RM TrackR resent after a dropout. */
  receivedAt: Date | null;
  deviceTimezone: string | null;
  source: "connector_live_tcp" | "connector_rewind";
  /** Resent by the RM TrackR after a dropout (rewindData), not read just now. */
  replayed?: boolean;
}

export interface ActiveTimingReplay {
  /** When RM Connect asked for the missed reads. */
  requestedAt: string;
  /** The gap that was replayed (laptop time). */
  from: string;
  to: string;
  /** Reads the RM TrackR resent for that gap so far. */
  reads: number;
}

/** "2026-6-30_17:34:25.333": the RM TrackR's local wall-clock format (rewindData and epc). */
export function formatDeviceTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}_${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** The RM TrackR's local wall-clock timestamp as a Date, with no skew clamp (null if malformed). */
export function parseDeviceWallTime(value: string): Date | null {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis.padEnd(3, "0")));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getHostTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function getCurrentUtcOffsetMinutes(now = new Date()): number {
  return -now.getTimezoneOffset();
}

export function formatLocalClockCommands(now = new Date()): { date: string; time: string } {
  const two = (value: number) => String(value).padStart(2, "0");
  const hundredths = two(Math.floor(now.getMilliseconds() / 10));
  return {
    date: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`,
    time: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${hundredths}`,
  };
}

export interface ActiveTransponderStatus {
  connected: boolean;
  host: string | null;
  port: number | null;
  machineId: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  /** The last replay of reads missed during a dropout, if any. */
  lastReplay: ActiveTimingReplay | null;
  machineState: Record<string, string>;
  activeSystemState: string | null;
  reading: boolean;
  transportReady: boolean;
  heartbeatFresh: boolean;
  loop1State: string | null;
  loop2State: string | null;
  loop1Enabled: boolean;
  loop2Enabled: boolean;
  /** A transponder pass since the loops were opened: they're reading. */
  loopsReading: boolean;
  configurationApplied: boolean;
  ready: boolean;
  diagnosis: string | null;
  detail: string | null;
  hostTimezone: string | null;
  utcOffsetMinutes: number;
}

/** Loop telemetry: firmware reports 1/0 or words such as "working" / "open" (matches the desktop app). */
export function isLoopWorking(value: string): boolean {
  return /^(1|true|enabled)$/i.test(value.trim()) || /working|running|open/i.test(value);
}

/**
 * Explains which enabled loop isn't reporting. The usual cause is a loop that
 * is turned on but not installed (many tracks run one loop), so say how to fix it.
 */
function silentLoopMessage(loopsOk: boolean[], retries: number, telemetry: boolean): string {
  // Some RM TrackR firmware never reports loop status. A transponder pass is
  // the proof then, so say that instead of blaming the cables.
  if (!telemetry) {
    return retries >= 3
      ? "Loops are on. Pass a transponder over the loop to confirm it's reading; the light turns green on the first pass."
      : "Starting the loops…";
  }
  const silent = loopsOk.map((ok, i) => (ok ? null : i + 1)).filter((n): n is number => n !== null);
  const which = silent.length === 1 ? `Loop ${silent[0]} isn't` : "The loops aren't";
  const hint = silent.length === 1 && silent.length < loopsOk.length
    ? ` If this RM TrackR only has one loop, turn Loop ${silent[0]} off in RM TrackR settings.`
    : " Check the loop cables at the RM TrackR.";
  return retries >= 3
    ? `${which} reporting as running yet.${hint} Reads still come through while this shows.`
    : "Starting the loops; waiting for the RM TrackR to confirm they're running…";
}

function friendlyConnectionError(error: Error, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return `The RM TrackR at ${host}:${port} refused the connection. Confirm its IP address and that TCP port ${port} is enabled.`;
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `Cannot reach the RM TrackR at ${host}:${port}. Check that this computer and reader are on the same network and TCP port ${port} is reachable.`;
  }
  if (code === "ENOTFOUND") return `The RM TrackR address "${host}" was not found. Check the IP address or hostname.`;
  return error.message || `Unable to connect to RM TrackR at ${host}:${port}.`;
}

function parseAddress(address: string): { host: string; port: number } {
  const value = address.trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const port = Number(bracketed[2] ?? F2000_PORT);
    return { host: bracketed[1], port: Number.isInteger(port) && port > 0 && port < 65536 ? port : F2000_PORT };
  }
  const colon = value.lastIndexOf(":");
  if (colon > 0 && value.indexOf(":") === colon) {
    const port = Number(value.slice(colon + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) return { host: value.slice(0, colon), port };
  }
  return { host: value, port: F2000_PORT };
}

export function parseTimestamp(value: string, receivedAt = new Date()): Date | null {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis = "0"] = match;
  const expected = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)];
  const date = new Date(...expected as [number, number, number, number, number, number], Number(millis.padEnd(3, "0")));
  const matchesWallTime = (candidate: Date) =>
    !Number.isNaN(candidate.getTime())
    && candidate.getFullYear() === expected[0]
    && candidate.getMonth() === expected[1]
    && candidate.getDate() === expected[2]
    && candidate.getHours() === expected[3]
    && candidate.getMinutes() === expected[4]
    && candidate.getSeconds() === expected[5];
  // A spring-forward wall time does not exist. For a fall-back wall time Node
  // chooses one occurrence; check nearby offsets and choose the one nearest the
  // socket receipt so either side of the transition is handled safely.
  if (!matchesWallTime(date)) return receivedAt;
  const candidates = [date];
  for (const offset of [-2, -1, 1, 2]) {
    const alternative = new Date(date.getTime() + offset * 60 * 60 * 1000);
    if (matchesWallTime(alternative)) candidates.push(alternative);
  }
  const nearest = candidates.reduce((best, candidate) =>
    Math.abs(candidate.getTime() - receivedAt.getTime()) < Math.abs(best.getTime() - receivedAt.getTime())
      ? candidate
      : best);
  return Math.abs(nearest.getTime() - receivedAt.getTime()) > MAX_DIRECT_CLOCK_SKEW_MS
    ? receivedAt
    : nearest;
}

function stateFields(parameters: string): Record<string, string> {
  return Object.fromEntries(
    parameters.split(",").map((part) => {
      const equals = part.indexOf("=");
      return equals < 0 ? [part.trim(), ""] : [part.slice(0, equals).trim(), part.slice(equals + 1).trim()];
    }).filter(([key]) => key),
  );
}

/** Events: tag(tag, time), connected, disconnected(reason), status. */
export class ActiveTransponderClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string | null = null;
  private port: number | null = null;
  private machineId: string | null = null;
  private lastError: string | null = null;
  private lastPassingAt: string | null = null;
  private passingCount = 0;
  // A transponder pass since the loops were last (re)opened proves they run,
  // whatever the loop telemetry says (some firmware never reports it).
  private loopsProvenByReads = false;
  private lastHeartbeatAt: string | null = null;
  private machineState: Record<string, string> = {};
  private activeSystemState: string | null = null;
  private receiveBuffer = "";
  private sequence = 0;
  private intentionalClose = false;
  private desiredReading = false;
  private readerCommandMachineId: string | null = null;
  private channel = 0;
  private power = 100;
  private loopEnabled = [true, true];
  private configurationApplied = false;
  private lastReaderOpenRequestAt = 0;
  private readerOpenRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readerOpenRetryCount = 0;
  private lastReaderOpenRetryAt: string | null = null;
  private socketEpoch = 0;
  // Replay after a dropout. The RM TrackR keeps reading and storing while the
  // network is down; on reconnect RM Connect asks it to resend that window.
  private lastContactAt: number | null = null;
  /** RM TrackR clock minus this laptop's, from the last live read. */
  private deviceOffsetMs = 0;
  /** Laptop time the current gap started (earliest, across failed retries). */
  private gapStartedAt: number | null = null;
  private replay: { fromDeviceMs: number; untilDeviceMs: number; offsetMs: number; expiresAt: number } | null = null;
  private lastReplay: ActiveTimingReplay | null = null;

  getStatus(): ActiveTransponderStatus {
    const connected = !!this.socket && !this.socket.destroyed;
    const heartbeatAge = this.lastHeartbeatAt ? Date.now() - new Date(this.lastHeartbeatAt).getTime() : null;
    const heartbeatFresh = heartbeatAge !== null && heartbeatAge <= HEARTBEAT_STALE_MS;
    const state = this.machineState;
    const enabledLoops = this.loopEnabled.map((enabled, index) =>
      !enabled || this.loopsProvenByReads || isLoopWorking(state[`reader${index + 1}Working`] ?? ""));
    const hasLoopTelemetry = state.reader1Working !== undefined || state.reader2Working !== undefined;
    const readersWorking = enabledLoops.every(Boolean);
    // Ready once connected, beating, configured and told to open its loops.
    // Loop telemetry doesn't gate this: some RM TrackR firmware reports a loop
    // as 0 (off) while it reads. A transponder pass is the proof it reads.
    const ready = connected && heartbeatFresh && this.desiredReading && this.configurationApplied
      && this.readerCommandMachineId === this.machineId;
    const loop1State = state.reader1Working ?? null;
    const loop2State = state.reader2Working ?? null;
    const machineSummary = ["batteryPercent"]
      .filter((key) => state[key] !== undefined)
      .map((key) => `${key.replace("Percent", "")}: ${state[key]}`)
      .join(", ");
    // Without loop telemetry, show what the reader does report, so support can see it.
    const rawState = !hasLoopTelemetry
      ? Object.entries(state).filter(([key]) => key !== "batteryPercent").map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 120)
      : "";
    const replayNote = this.lastReplay && Date.now() - new Date(this.lastReplay.requestedAt).getTime() < 10 * 60_000
      ? ` · reconnected: ${this.lastReplay.reads} missed read${this.lastReplay.reads === 1 ? "" : "s"} recovered`
      : "";
    const detail = this.machineId
      ? `${this.machineId}${this.activeSystemState ? ` · ${this.activeSystemState}` : ""}${machineSummary ? ` · ${machineSummary}` : ""}${rawState ? ` · reports ${rawState}` : ""}${replayNote}`
      : connected ? "Connected — waiting for RM TrackR machine identification" : null;
    const heartbeatError = connected && heartbeatAge !== null && !heartbeatFresh
      ? "RM TrackR heartbeat stopped — check the reader and network connection."
      : null;
    const diagnosis = this.lastError ?? heartbeatError ?? (!connected
      ? "Connect the RM TrackR on the same network using its IP address and TCP port 55555."
      : !this.machineId
        ? "Transport is connected. Waiting for the RM TrackR machine identification and heartbeat."
        : !heartbeatFresh
          ? "Waiting for a fresh RM TrackR heartbeat."
          : this.desiredReading && !readersWorking && !ready
            ? silentLoopMessage(enabledLoops, this.readerOpenRetryCount, hasLoopTelemetry)
            : this.desiredReading
              ? (this.loopsProvenByReads ? "Reading transponders." : "Ready. The first transponder pass confirms the loop is reading.")
              : "RM TrackR transport, heartbeat, and machine identification are ready.");
    return {
      connected, host: this.host, port: this.port, machineId: this.machineId,
      error: this.lastError ?? heartbeatError, lastPassingAt: this.lastPassingAt,
      passingCount: this.passingCount, lastHeartbeatAt: this.lastHeartbeatAt,
      lastReplay: this.lastReplay ? { ...this.lastReplay } : null,
      machineState: { ...state }, activeSystemState: this.activeSystemState,
      reading: ready, transportReady: connected && !!this.machineId, heartbeatFresh,
      loop1State, loop2State, loop1Enabled: this.loopEnabled[0],
      loop2Enabled: this.loopEnabled[1], loopsReading: this.loopsProvenByReads, configurationApplied: this.configurationApplied,
      ready, diagnosis, detail, hostTimezone: getHostTimezone(),
      utcOffsetMinutes: getCurrentUtcOffsetMinutes(),
    };
  }

  configure(input: { channel: number; power: number; loop1Enabled: boolean; loop2Enabled: boolean }): void {
    if (!Number.isInteger(input.channel) || input.channel < 0 || input.channel > 5) throw new Error("RM TrackR active channel must be between 0 and 5.");
    if (!Number.isInteger(input.power) || input.power < 0 || input.power > 100) throw new Error("RM TrackR active power must be between 0 and 100.");
    this.channel = input.channel;
    this.power = input.power;
    this.loopEnabled = [input.loop1Enabled, input.loop2Enabled];
    // New loop settings need a fresh pass (or telemetry) to show as running.
    this.loopsProvenByReads = false;
    this.configurationApplied = false;
    this.applyConfiguration(true);
    if (this.desiredReading) this.requestReaderOpen(true);
    this.ensureReaderOpenRetry();
    this.emit("status");
  }

  syncClock(): void {
    if (!this.machineId) throw new Error("RM TrackR is not identified yet. Connect it before syncing its clock.");
    this.sendClockCommands();
    this.emit("status");
  }

  connect(address: string): Promise<void> {
    // Reconnecting to the same reader replays from the dropout (or, for a
    // connection that froze without closing, from the last contact). Reads that
    // did get through are rejected as duplicates by RM Roost.
    const pendingGap = this.gapStartedAt ?? this.lastContactAt;
    this.disconnect();
    const socketEpoch = ++this.socketEpoch;
    const { host, port } = parseAddress(address);
    if (!host) return Promise.reject(new Error("Enter an RM TrackR IP address or hostname."));
    // A different address is a different reader: nothing of the old gap applies.
    if (host === this.host && port === this.port) this.gapStartedAt = pendingGap;
    else this.lastContactAt = null;
    this.intentionalClose = false;
    this.lastError = null;
    this.host = host;
    this.port = port;
    this.machineId = null;
    this.readerCommandMachineId = null;
    this.configurationApplied = false;
    this.lastReaderOpenRequestAt = 0;
    this.readerOpenRetryCount = 0;
    this.lastReaderOpenRetryAt = null;
    this.loopsProvenByReads = false;
    this.receiveBuffer = "";

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
      let settled = false;
      const fail = (error: Error) => {
        if (socketEpoch !== this.socketEpoch) return;
        this.lastError = friendlyConnectionError(error, host, port);
        if (!settled) { settled = true; reject(error); }
      };
      socket.once("connect", () => {
        if (socketEpoch !== this.socketEpoch) {
          socket.destroy();
          return;
        }
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 1_000);
        socket.setTimeout(0);
        this.socket = socket;
        settled = true;
        this.emit("connected");
        resolve();
      });
      socket.once("timeout", () => {
        const error = new Error(`Cannot reach the RM TrackR at ${host}:${port}. Check the IP address, same network, and TCP port ${port}.`);
        fail(error);
        socket.destroy();
      });
      socket.on("data", (chunk: Buffer) => {
        if (this.socket === socket && socketEpoch === this.socketEpoch) this.receive(chunk.toString("utf8"), new Date());
      });
      socket.on("error", (error) => fail(error));
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.clearReaderOpenRetry();
        this.socket = null;
        // Reads during the gap stay on the RM TrackR: replay them on reconnect.
        if (!this.intentionalClose && this.lastContactAt !== null && this.gapStartedAt === null) {
          this.gapStartedAt = this.lastContactAt;
        }
        if (!this.intentionalClose && settled) this.emit("disconnected", this.lastError ?? "RM TrackR connection closed");
        this.emit("status");
      });
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    // A deliberate disconnect isn't a dropout: nothing to replay.
    this.gapStartedAt = null;
    this.replay = null;
    this.socketEpoch++;
    this.clearReaderOpenRetry();
    if (this.desiredReading) this.sendReaderCommand("readerStop");
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    this.desiredReading = false;
    this.readerCommandMachineId = null;
    this.lastReaderOpenRequestAt = 0;
    this.readerOpenRetryCount = 0;
    this.lastReaderOpenRetryAt = null;
    this.loopsProvenByReads = false;
  }

  startReading(): void {
    this.desiredReading = true;
    this.applyConfiguration(false);
    this.requestReaderOpen(true);
    this.ensureReaderOpenRetry();
    this.emit("status");
  }

  stopReading(): void {
    this.desiredReading = false;
    this.clearReaderOpenRetry();
    this.sendReaderCommand("readerStop");
    this.readerCommandMachineId = null;
    this.lastReaderOpenRequestAt = 0;
    this.readerOpenRetryCount = 0;
    this.lastReaderOpenRetryAt = null;
    this.loopsProvenByReads = false;
    this.emit("status");
  }

  private receive(data: string, receivedAt: Date): void {
    this.receiveBuffer += data;
    if (this.receiveBuffer.length > 64 * 1024) this.receiveBuffer = this.receiveBuffer.slice(-4096);
    let end: number;
    while ((end = this.receiveBuffer.indexOf(";")) >= 0) {
      const packet = this.receiveBuffer.slice(0, end).trim();
      this.receiveBuffer = this.receiveBuffer.slice(end + 1);
      if (packet) this.handlePacket(packet, receivedAt);
    }
  }

  private handlePacket(packet: string, receivedAt: Date): void {
    const fields = packet.split("@");
    if (fields.length < 3) return;
    const [machineId, command, , ...parameterParts] = fields;
    const parameters = parameterParts.join("@");
    if (!machineId || !command) return;
    this.lastContactAt = receivedAt.getTime();
    const requiresInitialization = this.machineId !== machineId;
    this.machineId = machineId;
    this.lastError = null;
    if (requiresInitialization) {
      this.loopsProvenByReads = false;
      this.configurationApplied = false;
      this.readerCommandMachineId = null;
      this.lastReaderOpenRequestAt = 0;
      this.readerOpenRetryCount = 0;
      this.lastReaderOpenRetryAt = null;
      // Queue local wall-clock synchronization and all saved settings before
      // handling this packet. In particular, a first-packet crossing must not
      // escape before the initialization writes and reader-open request.
      this.applyConfiguration(true);
      this.requestReaderOpen(true);
      this.requestReplay(receivedAt);
    }

    switch (command) {
      case "heartBeat":
        this.lastHeartbeatAt = new Date().toISOString();
        break;
      case "epc": {
        const comma = parameters.indexOf(",");
        const stamp = comma >= 0 ? parameters.slice(0, comma) : "";
        const tag = (comma >= 0 ? parameters.slice(comma + 1) : parameters).trim();
        const deviceTime = parseDeviceWallTime(stamp);
        const replay = this.replay && receivedAt.getTime() <= this.replay.expiresAt ? this.replay : null;
        if (tag && deviceTime && replay
          && deviceTime.getTime() >= replay.fromDeviceMs && deviceTime.getTime() <= replay.untilDeviceMs) {
          // Resent from the dropout: keep the moment it was read (in this
          // laptop's time), never the moment it arrived.
          const time = new Date(deviceTime.getTime() - replay.offsetMs);
          if (this.lastReplay) this.lastReplay.reads++;
          this.emit("tag", tag, time, {
            receivedAt: null,
            deviceTimezone: getHostTimezone(),
            source: "connector_rewind",
            replayed: true,
          } satisfies ActiveTimingReceiptMetadata);
          break;
        }
        if (deviceTime && Math.abs(deviceTime.getTime() - receivedAt.getTime()) < 24 * 60 * 60 * 1000) {
          this.deviceOffsetMs = deviceTime.getTime() - receivedAt.getTime();
        }
        const time = parseTimestamp(stamp, receivedAt);
        if (tag && time) {
          this.lastPassingAt = time.toISOString();
          this.passingCount++;
          if (this.desiredReading && !this.loopsProvenByReads) {
            // Reading works: stop re-opening and re-configuring the loops,
            // which can briefly interrupt them.
            this.loopsProvenByReads = true;
            this.clearReaderOpenRetry();
          }
          this.emit("tag", tag, time, {
            receivedAt,
            deviceTimezone: getHostTimezone(),
            source: "connector_live_tcp",
          } satisfies ActiveTimingReceiptMetadata);
        }
        break;
      }
      case "machineState":
        this.machineState = stateFields(parameters);
        break;
      case "activeSystemState":
        this.activeSystemState = parameters || null;
        break;
      case "packDataResult":
        if (/^failed/i.test(parameters)) this.lastError = parameters;
        break;
    }
    if (!this.configurationApplied) this.applyConfiguration(true);
    this.requestReaderOpen();
    this.ensureReaderOpenRetry();
    this.emit("status");
  }

  private enabledLoopsAreRunning(): boolean {
    if (this.loopsProvenByReads) return true;
    return this.loopEnabled.every(
      (enabled, index) => !enabled || isLoopWorking(this.machineState[`reader${index + 1}Working`] ?? ""),
    );
  }

  private requestReaderOpen(force = false): void {
    if (!this.desiredReading || !this.socket || this.socket.destroyed || !this.machineId) return;
    if (!force && this.enabledLoopsAreRunning()) return;
    const now = Date.now();
    if (!force && now - this.lastReaderOpenRequestAt < READER_OPEN_RETRY_MS) return;
    this.sendReaderCommand("readerOpen");
    this.lastReaderOpenRequestAt = now;
  }

  /**
   * The protocol has no acknowledgement for readerOpen. Keep one socket-owned
   * retry pending until machineState telemetry, not a write, confirms every
   * enabled loop is running.
   */
  private ensureReaderOpenRetry(): void {
    if (!this.desiredReading || !this.socket || this.socket.destroyed || !this.machineId || this.enabledLoopsAreRunning()
      || this.readerOpenRetryCount >= MAX_READER_OPEN_RETRIES) {
      this.clearReaderOpenRetry();
      return;
    }
    if (this.readerOpenRetryTimer) return;
    const socket = this.socket;
    const epoch = this.socketEpoch;
    this.readerOpenRetryTimer = setTimeout(() => {
      this.readerOpenRetryTimer = null;
      if (this.socket !== socket || epoch !== this.socketEpoch || !this.desiredReading || socket.destroyed || !this.machineId) return;
      if (this.enabledLoopsAreRunning()) {
        this.clearReaderOpenRetry();
        this.emit("status");
        return;
      }
      this.readerOpenRetryCount++;
      this.lastReaderOpenRetryAt = new Date().toISOString();
      if (this.readerOpenRetryCount % FULL_CONFIGURATION_RETRY_INTERVAL === 0) {
        // RF settings can reset a loop to stopped while the F2000 applies them.
        // Reconfigure only occasionally, then let the next retry send readerOpen
        // after the device has had a full retry interval to settle.
        this.applyConfiguration(false);
      } else {
        this.requestReaderOpen(true);
      }
      this.ensureReaderOpenRetry();
      this.emit("status");
    }, READER_OPEN_RETRY_MS);
  }

  private clearReaderOpenRetry(): void {
    if (this.readerOpenRetryTimer) clearTimeout(this.readerOpenRetryTimer);
    this.readerOpenRetryTimer = null;
  }

  private sendReaderCommand(command: "readerOpen" | "readerStop"): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    for (const reader of ["1", "2"]) {
      if (command === "readerOpen" && !this.loopEnabled[Number(reader) - 1]) continue;
      this.sendCommand(command, reader);
    }
    if (command === "readerOpen") this.readerCommandMachineId = this.machineId;
  }

  private applyConfiguration(includeClock: boolean): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    if (includeClock) this.sendClockCommands();
    this.sendCommand("setActiveChannel", String(this.channel));
    this.sendCommand("setActivePower", String(this.power));
    this.sendCommand(this.loopEnabled[0] ? "loopEnable" : "loopDisable", "1");
    this.sendCommand(this.loopEnabled[1] ? "loopEnable" : "loopDisable", "2");
    this.configurationApplied = true;
    this.readerCommandMachineId = null;
    this.lastReaderOpenRequestAt = 0;
  }

  /**
   * After a dropout, ask the RM TrackR to resend what it read while RM Connect
   * couldn't hear it (rewindData). Reads that did get through are rejected as
   * duplicates by RM Roost, so the window starts a little before the last contact.
   */
  private requestReplay(now: Date): void {
    if (this.gapStartedAt === null) return;
    const nowMs = now.getTime();
    const fromMs = Math.max(this.gapStartedAt - REPLAY_OVERLAP_MS, nowMs - MAX_REPLAY_SPAN_MS);
    const offsetMs = this.deviceOffsetMs;
    this.gapStartedAt = null;
    if (nowMs <= fromMs) return;
    this.replay = {
      fromDeviceMs: fromMs + offsetMs,
      untilDeviceMs: nowMs + offsetMs,
      offsetMs,
      expiresAt: nowMs + REPLAY_WINDOW_MS,
    };
    this.lastReplay = { requestedAt: now.toISOString(), from: new Date(fromMs).toISOString(), to: now.toISOString(), reads: 0 };
    this.sendCommand("rewindData", `${formatDeviceTime(fromMs + offsetMs)},${formatDeviceTime(nowMs + offsetMs)}`);
  }

  private sendClockCommands(): void {
    const { date, time } = formatLocalClockCommands();
    this.sendCommand("setDate", date);
    this.sendCommand("setTime", time);
  }

  private sendCommand(command: string, parameters: string): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    const sequence = String(this.sequence++ % 10_000).padStart(4, "0");
    try {
      this.socket.write(`${this.machineId}@${command}@${sequence}@${parameters};`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unable to send command to RM TrackR";
    }
  }
}