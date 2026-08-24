/**
 * Feibot F2000 active-transponder client.
 *
 * The F2000 socket protocol is UTF-8 text framed by semicolons:
 *   machineId@cmd@cmdSN@parameters;
 */
import net from "net";
import { EventEmitter } from "events";

const FEIBOT_PORT = 3333;
const CONNECT_TIMEOUT_MS = 8_000;
const HEARTBEAT_STALE_MS = 5_000;

export interface FeibotStatus {
  connected: boolean;
  host: string | null;
  machineId: string | null;
  error: string | null;
  lastPassingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  machineState: Record<string, string>;
  activeSystemState: string | null;
  reading: boolean;
  detail: string | null;
}

function parseAddress(address: string): { host: string; port: number } {
  const value = address.trim();
  // Bracketed IPv6 is the unambiguous host:port form.
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const port = Number(bracketed[2] ?? FEIBOT_PORT);
    return { host: bracketed[1], port: Number.isInteger(port) && port > 0 && port < 65536 ? port : FEIBOT_PORT };
  }
  const colon = value.lastIndexOf(":");
  if (colon > 0 && value.indexOf(":") === colon) {
    const port = Number(value.slice(colon + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { host: value.slice(0, colon), port };
    }
  }
  return { host: value, port: FEIBOT_PORT };
}

function parseTimestamp(value: string): Date | null {
  // Device format: YYYY-M-D_HH:mm:ss.SSS. Construct locally to avoid
  // implementation-dependent parsing of non-zero-padded date strings.
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millis.padEnd(3, "0")));
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute) ||
    date.getSeconds() !== Number(second)
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
export class FeibotClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private host: string | null = null;
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

  getStatus(): FeibotStatus {
    const connected = !!this.socket && !this.socket.destroyed;
    const heartbeatAge = this.lastHeartbeatAt ? Date.now() - new Date(this.lastHeartbeatAt).getTime() : null;
    const heartbeatFresh = heartbeatAge !== null && heartbeatAge <= HEARTBEAT_STALE_MS;
    const state = this.machineState;
    const readersWorking = ["reader1Working", "reader2Working"]
      .some((key) => /working|running|open/i.test(state[key] ?? ""));
    const reading = connected && this.desiredReading && (readersWorking || heartbeatFresh || this.activeSystemState !== null);
    const machineSummary = ["batteryPercent", "reader1Working", "reader2Working"]
      .filter((key) => state[key] !== undefined)
      .map((key) => `${key.replace("Percent", "")}: ${state[key]}`)
      .join(", ");
    const detail = this.machineId
      ? `${this.machineId}${this.activeSystemState ? ` · ${this.activeSystemState}` : ""}${machineSummary ? ` · ${machineSummary}` : ""}`
      : connected ? "Connected — waiting for Feibot machine identification" : null;
    const heartbeatError = connected && heartbeatAge !== null && !heartbeatFresh
      ? "Feibot heartbeat stopped — check the reader and network connection."
      : null;
    return { connected, host: this.host, machineId: this.machineId, error: this.lastError ?? heartbeatError, lastPassingAt: this.lastPassingAt, passingCount: this.passingCount, lastHeartbeatAt: this.lastHeartbeatAt, machineState: { ...state }, activeSystemState: this.activeSystemState, reading, detail };
  }

  connect(address: string): Promise<void> {
    this.disconnect();
    const { host, port } = parseAddress(address);
    if (!host) return Promise.reject(new Error("Enter a Feibot IP address or hostname."));
    this.intentionalClose = false;
    this.lastError = null;
    this.host = host;
    this.machineId = null;
    this.readerCommandMachineId = null;
    this.receiveBuffer = "";

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
      let settled = false;
      const fail = (error: Error) => {
        this.lastError = error.message;
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
        const error = new Error(`Connection timed out — verify the Feibot is reachable on TCP port ${port}.`);
        fail(error);
        socket.destroy();
      });
      socket.on("data", (chunk: Buffer) => this.receive(chunk.toString("utf8")));
      socket.on("error", (error) => fail(error));
      socket.on("close", () => {
        // A socket deliberately superseded by a reconnect must not announce a
        // stale disconnect for the newer connection attempt.
        if (this.socket !== socket) return;
        this.socket = null;
        if (!this.intentionalClose && settled) this.emit("disconnected", this.lastError ?? "Feibot connection closed");
        this.emit("status");
      });
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    this.desiredReading = false;
    this.readerCommandMachineId = null;
  }

  startReading(): void {
    this.desiredReading = true;
    this.sendReaderCommand("readerOpen");
    this.emit("status");
  }

  stopReading(): void {
    this.desiredReading = false;
    this.sendReaderCommand("readerStop");
    this.readerCommandMachineId = null;
    this.emit("status");
  }

  private receive(data: string): void {
    this.receiveBuffer += data;
    // Keep a malformed stream from growing unboundedly while preserving a
    // possible partial packet at the tail.
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
    // A reader start requested before the first device packet can now be sent.
    if (this.desiredReading && this.readerCommandMachineId !== this.machineId) this.sendReaderCommand("readerOpen");
    this.emit("status");
  }

  private sendReaderCommand(command: "readerOpen" | "readerStop"): void {
    if (!this.socket || this.socket.destroyed || !this.machineId) return;
    // F2000 commands operate on one reader at a time. Use both available loops.
    for (const reader of ["1", "2"]) {
      const sequence = String(this.sequence++ % 10_000).padStart(4, "0");
      try {
        this.socket.write(`${this.machineId}@${command}@${sequence}@${reader};`);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "Unable to send command to Feibot";
      }
    }
    if (command === "readerOpen") this.readerCommandMachineId = this.machineId;
  }
}