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

export interface ActiveTransponderStatus {
  connected: boolean;
  host: string | null;
  port: number | null;
  machineId: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  machineState: Record<string, string>;
  activeSystemState: string | null;
  reading: boolean;
  transportReady: boolean;
  heartbeatFresh: boolean;
  loop1State: string | null;
  loop2State: string | null;
  loop1Enabled: boolean;
  loop2Enabled: boolean;
  configurationApplied: boolean;
  ready: boolean;
  diagnosis: string | null;
  detail: string | null;
}

function friendlyConnectionError(error: Error, host: string, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return `The F2000 at ${host}:${port} refused the connection. Confirm its IP address and that TCP port ${port} is enabled.`;
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `Cannot reach the F2000 at ${host}:${port}. Check that this computer and reader are on the same network and TCP port ${port} is reachable.`;
  }
  if (code === "ENOTFOUND") return `The F2000 address "${host}" was not found. Check the IP address or hostname.`;
  return error.message || `Unable to connect to F2000 at ${host}:${port}.`;
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

function parseTimestamp(value: string): Date | null {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis.padEnd(3, "0")));
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)
    || date.getHours() !== Number(hour)
    || date.getMinutes() !== Number(minute)
    || date.getSeconds() !== Number(second)
  ) return null;
  return date;
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

  getStatus(): ActiveTransponderStatus {
    const connected = !!this.socket && !this.socket.destroyed;
    const heartbeatAge = this.lastHeartbeatAt ? Date.now() - new Date(this.lastHeartbeatAt).getTime() : null;
    const heartbeatFresh = heartbeatAge !== null && heartbeatAge <= HEARTBEAT_STALE_MS;
    const state = this.machineState;
    const enabledLoops = this.loopEnabled.map((enabled, index) => !enabled || /working|running|open/i.test(state[`reader${index + 1}Working`] ?? ""));
    const readersWorking = enabledLoops.every(Boolean);
    const ready = connected && this.desiredReading && this.configurationApplied
      && this.readerCommandMachineId === this.machineId && readersWorking;
    const loop1State = state.reader1Working ?? null;
    const loop2State = state.reader2Working ?? null;
    const machineSummary = ["batteryPercent", "reader1Working", "reader2Working"]
      .filter((key) => state[key] !== undefined)
      .map((key) => `${key.replace("Percent", "")}: ${state[key]}`)
      .join(", ");
    const detail = this.machineId
      ? `${this.machineId}${this.activeSystemState ? ` · ${this.activeSystemState}` : ""}${machineSummary ? ` · ${machineSummary}` : ""}`
      : connected ? "Connected — waiting for F2000 machine identification" : null;
    const heartbeatError = connected && heartbeatAge !== null && !heartbeatFresh
      ? "F2000 heartbeat stopped — check the reader and network connection."
      : null;
    const diagnosis = this.lastError ?? heartbeatError ?? (!connected
      ? "Connect the F2000 on the same network using its IP address and TCP port 55555."
      : !this.machineId
        ? "Transport is connected. Waiting for the F2000 machine identification and heartbeat."
        : !heartbeatFresh
          ? "Waiting for a fresh F2000 heartbeat."
          : this.desiredReading && !readersWorking
            ? "Opening enabled loops; waiting for the F2000 to confirm they are running. RM Connect will retry the open command."
            : "F2000 transport, heartbeat, and machine identification are ready.");
    return {
      connected, host: this.host, port: this.port, machineId: this.machineId,
      error: this.lastError ?? heartbeatError, lastPassingAt: this.lastPassingAt,
      passingCount: this.passingCount, lastHeartbeatAt: this.lastHeartbeatAt,
      machineState: { ...state }, activeSystemState: this.activeSystemState,
      reading: ready, transportReady: connected && !!this.machineId, heartbeatFresh,
      loop1State, loop2State, loop1Enabled: this.loopEnabled[0],
      loop2Enabled: this.loopEnabled[1], configurationApplied: this.configurationApplied,
      ready, diagnosis, detail,
    };
  }

  configure(input: { channel: number; power: number; loop1Enabled: boolean; loop2Enabled: boolean }): void {
    if (!Number.isInteger(input.channel) || input.channel < 0 || input.channel > 5) throw new Error("F2000 active channel must be between 0 and 5.");
    if (!Number.isInteger(input.power) || input.power < 0 || input.power > 100) throw new Error("F2000 active power must be between 0 and 100.");
    this.channel = input.channel;
    this.power = input.power;
    this.loopEnabled = [input.loop1Enabled, input.loop2Enabled];
    this.configurationApplied = false;
    this.applyConfiguration(false);
    this.emit("status");
  }

  syncClock(): void {
    if (!this.machineId) throw new Error("F2000 is not identified yet. Connect it before syncing its clock.");
    this.sendClockCommands();
    this.emit("status");
  }

  connect(address: string): Promise<void> {
    this.disconnect();
    const { host, port } = parseAddress(address);
    if (!host) return Promise.reject(new Error("Enter an F2000 IP address or hostname."));
    this.intentionalClose = false;
    this.lastError = null;
    this.host = host;
    this.port = port;
    this.machineId = null;
    this.readerCommandMachineId = null;
    this.configurationApplied = false;
    this.lastReaderOpenRequestAt = 0;
    this.receiveBuffer = "";

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
      let settled = false;
      const fail = (error: Error) => {
        this.lastError = friendlyConnectionError(error, host, port);
        if (!settled) { settled = true; reject(error); }
      };
      socket.once("connect", () => {
        socket.setTimeout(0);
        this.socket = socket;
        settled = true;
        this.emit("connected");
        resolve();
      });
      socket.once("timeout", () => {
        const error = new Error(`Cannot reach the F2000 at ${host}:${port}. Check the IP address, same network, and TCP port ${port}.`);
        fail(error);
        socket.destroy();
      });
      socket.on("data", (chunk: Buffer) => this.receive(chunk.toString("utf8")));
      socket.on("error", (error) => fail(error));
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!this.intentionalClose && settled) this.emit("disconnected", this.lastError ?? "F2000 connection closed");
        this.emit("status");
      });
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.desiredReading) this.sendReaderCommand("readerStop");
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    this.desiredReading = false;
    this.readerCommandMachineId = null;
    this.lastReaderOpenRequestAt = 0;
  }

  startReading(): void {
    this.desiredReading = true;
    this.applyConfiguration(false);
    this.requestReaderOpen(true);
    this.emit("status");
  }

  stopReading(): void {
    this.desiredReading = false;
    this.sendReaderCommand("readerStop");
    this.readerCommandMachineId = null;
    this.lastReaderOpenRequestAt = 0;
    this.emit("status");
  }

  private receive(data: string): void {
    this.receiveBuffer += data;
    if (this.receiveBuffer.length > 64 * 1024) this.receiveBuffer = this.receiveBuffer.slice(-4096);
    let end: number;
    while ((end = this.receiveBuffer.indexOf(";")) >= 0) {
      const packet = this.receiveBuffer.slice(0, end).trim();
      this.receiveBuffer = this.receiveBuffer.slice(end + 1);
      if (packet) this.handlePacket(packet);
    }
  }

  private handlePacket(packet: string): void {
    const fields = packet.split("@");
    if (fields.length < 3) return;
    const [machineId, command, , ...parameterParts] = fields;
    const parameters = parameterParts.join("@");
    if (!machineId || !command) return;
    this.machineId = machineId;
    this.lastError = null;

    switch (command) {
      case "heartBeat":
        this.lastHeartbeatAt = new Date().toISOString();
        break;
      case "epc": {
        const comma = parameters.indexOf(",");
        const time = parseTimestamp(comma >= 0 ? parameters.slice(0, comma) : "");
        const tag = (comma >= 0 ? parameters.slice(comma + 1) : parameters).trim();
        if (tag && time) {
          this.lastPassingAt = time.toISOString();
          this.passingCount++;
          this.emit("tag", tag, time);
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
    this.emit("status");
  }

  private enabledLoopsAreRunning(): boolean {
    return this.loopEnabled.every(
      (enabled, index) => !enabled || /working|running|open/i.test(this.machineState[`reader${index + 1}Working`] ?? ""),
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
    this.sendCommand(this.loopEnabled[0] ? "loopEnable" : "loopDisable", "1");
    this.sendCommand(this.loopEnabled[1] ? "loopEnable" : "loopDisable", "2");
    this.sendCommand("setActiveChannel", String(this.channel));
    this.sendCommand("setActivePower", String(this.power));
    this.configurationApplied = true;
    this.readerCommandMachineId = null;
    this.lastReaderOpenRequestAt = 0;
  }

  private sendClockCommands(): void {
    const now = new Date();
    const date = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const hundredths = String(Math.floor(now.getMilliseconds() / 10)).padStart(2, "0");
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${hundredths}`;
    this.sendCommand("setDate", date);
    this.sendCommand("setTime", time);
  }

  private sendCommand(command: string, parameters: string): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    const sequence = String(this.sequence++ % 10_000).padStart(4, "0");
    try {
      this.socket.write(`${this.machineId}@${command}@${sequence}@${parameters};`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Unable to send command to F2000";
    }
  }
}