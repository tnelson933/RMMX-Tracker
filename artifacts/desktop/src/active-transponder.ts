import net from "net";

// Feibot F2000 TCP protocol (v3.2). Packets are:
// machineId@cmd@cmdSN@parameters; (normally TCP port 55555).

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
  error: string | null;
  diagnosis: string;
  lastPassingAt: string | null;
  /** Preferred name for new consumers; lastPassingAt remains for compatibility. */
  lastCrossingAt: string | null;
  passingCount: number;
  lastHeartbeatAt: string | null;
  reconnectAttempt: number;
  reconnectCountdownMs: number | null;
  configApplied: boolean;
  loopsReady: boolean;
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
}

export interface ActiveTransponderConfiguration {
  activeChannel: number;
  activePower: number;
  loopEnabled: [boolean, boolean];
}

export type ActiveTransponderPassingCallback = (epc: string, crossingTime: Date) => void;
export type ActiveTransponderStatusCallback = (status: ActiveTransponderStatus) => void;

const ACTIVE_TRANSPONDER_PORT = 55555;
const CONNECT_TIMEOUT_MS = 8_000;
const RECONNECT_DELAY_MS = 1_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const READER_OPEN_RETRY_MS = 2_000;
const DEFAULT_CONFIGURATION: ActiveTransponderConfiguration = {
  activeChannel: 0,
  activePower: 100,
  loopEnabled: [true, true],
};

export function normalizeActiveTransponderAddress(address: string): { host: string; port: number; address: string } {
  const value = address.trim();
  if (!value) throw new Error("Enter a Feibot F2000 IP address or hostname.");
  // Bracketed IPv6 is accepted; unbracketed IPv6 uses the default port.
  const bracketed = /^\[([^\]]+)\](?::(.+))?$/.exec(value);
  const colon = value.lastIndexOf(":");
  const hasSingleColonPort = colon > 0 && value.indexOf(":") === colon;
  const host = bracketed ? bracketed[1] : hasSingleColonPort ? value.slice(0, colon) : value;
  const portText = bracketed ? bracketed[2] : hasSingleColonPort ? value.slice(colon + 1) : undefined;
  if (!host) throw new Error("Enter a Feibot F2000 IP address or hostname.");
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) throw new Error("Feibot F2000 port must be a number between 1 and 65535.");
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("Feibot F2000 port must be between 1 and 65535.");
    }
    return { host, port, address: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}` };
  }
  return { host, port: ACTIVE_TRANSPONDER_PORT, address: host };
}

let socket: net.Socket | null = null;
let deviceIp: string | null = null;
let targetPort: number | null = null;
let machineId: string | null = null;
let lastPassingAt: string | null = null;
let passingCount = 0;
let lastHeartbeatAt: string | null = null;
let batteryPercent: number | null = null;
let totalTagsRead: number | null = null;
let differentTagsRead: number | null = null;
let reader1Working: string | null = null;
let reader2Working: string | null = null;
let eventId: string | null = null;
let connectError: string | null = null;
let recvBuffer = "";
let commandSerialNumber = 0;
let reader1State: "open" | "closed" | "unknown" = "unknown";
let reader2State: "open" | "closed" | "unknown" = "unknown";
let statusCallback: ActiveTransponderStatusCallback | undefined;
let passingCallback: ActiveTransponderPassingCallback | undefined;
let desiredConnected = false;
let localReaderActive = false;
let testActive = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAt: number | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let connectingSocket: net.Socket | null = null;
let targetHost: string | null = null;
let connectionEpoch = 0;
let connectionAttempt = 0;
let reconnectAttempt = 0;
let configuration: ActiveTransponderConfiguration = {
  ...DEFAULT_CONFIGURATION,
  loopEnabled: [...DEFAULT_CONFIGURATION.loopEnabled],
};
let configApplied = false;
let lastReaderOpenRequestAt = 0;
const intentionallyDisconnectedSockets = new WeakSet<net.Socket>();

export function getActiveTransponderStatus(): ActiveTransponderStatus {
  const connected = !!socket && !socket.destroyed;
  const state = getState(connected);
  const loopsReady = areEnabledLoopsTelemetryReady();
  return {
    connected,
    state,
    deviceIp,
    port: targetPort,
    machineId,
    error: connectError,
    diagnosis: getDiagnosis(state),
    lastPassingAt,
    lastCrossingAt: lastPassingAt,
    passingCount,
    lastHeartbeatAt,
    reconnectAttempt,
    reconnectCountdownMs: reconnectAt === null ? null : Math.max(0, reconnectAt - Date.now()),
    configApplied,
    loopsReady,
    ready: configApplied && (!readersShouldBeOpen() || loopsReady),
    activeChannel: configuration.activeChannel,
    activePower: configuration.activePower,
    loopEnabled: [...configuration.loopEnabled] as [boolean, boolean],
    reader1State,
    reader2State,
    batteryPercent,
    totalTagsRead,
    differentTagsRead,
    reader1Working,
    reader2Working,
    eventId,
  };
}

export function connectActiveTransponder(address: string, onPassing: ActiveTransponderPassingCallback, onStatus?: ActiveTransponderStatusCallback): Promise<void> {
  const { host, port } = normalizeActiveTransponderAddress(address);
  disconnectActiveTransponder();
  resetConnectionState();
  deviceIp = host;
  targetPort = port;
  statusCallback = onStatus;
  passingCallback = onPassing;
  desiredConnected = true;
  targetHost = host;
  const epoch = ++connectionEpoch;
  notifyStatus();
  return createConnection(host, port, epoch, true);
}

export function disconnectActiveTransponder(): void {
  desiredConnected = false;
  testActive = false;
  localReaderActive = false;
  connectionEpoch++;
  clearReconnectTimer();
  stopReaders();
  for (const connection of [socket, connectingSocket]) {
    if (connection && !connection.destroyed) {
      intentionallyDisconnectedSockets.add(connection);
      connection.end();
      connection.destroy();
    }
  }
  socket = null;
  connectingSocket = null;
  targetHost = null;
  targetPort = null;
  resetConnectionState();
  statusCallback = undefined;
  passingCallback = undefined;
}

/** Called by the local reader-state poll. Its state always remains authoritative for racing. */
export function setActiveTransponderReading(reading: boolean): void {
  localReaderActive = reading;
  syncReaders();
  notifyStatus();
}

export function configureActiveTransponder(config: ActiveTransponderConfiguration): void {
  validateConfiguration(config);
  configuration = {
    activeChannel: config.activeChannel,
    activePower: config.activePower,
    loopEnabled: [...config.loopEnabled] as [boolean, boolean],
  };
  configApplied = false;
  if (socket && !socket.destroyed && machineId) {
    // Reconfigure safely: close readers, set all device parameters, then reopen
    // only the enabled loops if local race/test state still requires them.
    stopReaders();
    applyConfiguration();
  }
  notifyStatus();
}

/** Synchronizes the F2000's local clock using separate V3.2 date/time commands. */
export function syncActiveTransponderClock(): void {
  if (!socket || socket.destroyed || !machineId) {
    throw new Error("Connect to the Feibot F2000 and wait for its machine ID before syncing its clock.");
  }
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  sendCommand("setDate", `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`);
  sendCommand("setTime", `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}.${two(Math.floor(now.getMilliseconds() / 10))}`);
  notifyStatus();
}

/** Opens both loops for a hardware test. A crossing is only reported when the F2000 actually sends one. */
export function startActiveTransponderTest(): void {
  if (!desiredConnected) throw new Error("Connect to the Feibot F2000 before starting a loop test.");
  testActive = true;
  connectError = null;
  syncReaders();
  notifyStatus();
}

export function stopActiveTransponderTest(): void {
  testActive = false;
  syncReaders();
  notifyStatus();
}

/** Lets the IPC bridge surface a rejected real crossing (for example, no active moto). */
export function reportActiveTransponderError(message: string): void {
  connectError = message;
  notifyStatus();
}

function createConnection(host: string, port: number, epoch: number, reportInitialResult: boolean): Promise<void> {
  const attempt = ++connectionAttempt;
  const connection = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS });
  connectingSocket = connection;
  let connected = false;
  let settled = false;
  const isCurrent = () => desiredConnected && connectionEpoch === epoch && connectionAttempt === attempt;

  return new Promise((resolve, reject) => {
    const failInitial = (error: Error) => {
      if (reportInitialResult && !settled) { settled = true; reject(error); }
    };
    connection.once("connect", () => {
      if (!isCurrent()) { intentionallyDisconnectedSockets.add(connection); connection.destroy(); return; }
      connected = true; settled = true;
      if (connectingSocket === connection) connectingSocket = null;
      socket = connection;
      connection.setTimeout(0);
      connectError = null;
      reconnectAttempt = 0;
      reconnectAt = null;
      armHeartbeatWatch();
      syncReaders();
      notifyStatus();
      if (reportInitialResult) resolve();
    });
    connection.once("timeout", () => {
      if (!isCurrent()) return;
      const error = new Error(`Connection to ${host}:${port} timed out. Check the F2000 address, power, Ethernet/Wi-Fi network, and port ${port}.`);
      connectError = error.message;
      connection.destroy();
      notifyStatus();
      if (!connected) failInitial(error);
    });
    connection.on("data", (chunk: Buffer) => {
      if (!isCurrent() || socket !== connection) return;
      recvBuffer += chunk.toString("utf8");
      processPackets(passingCallback);
    });
    connection.on("error", (error) => {
      if (!isCurrent()) return;
      connectError = `F2000 network error at ${host}:${port}: ${error.message}`;
      notifyStatus();
      if (!connected) failInitial(new Error(connectError));
    });
    connection.on("close", () => {
      if (socket === connection) socket = null;
      if (connectingSocket === connection) connectingSocket = null;
      if (!isCurrent()) { if (!connected) failInitial(new Error("Connection attempt cancelled.")); return; }
      clearHeartbeatWatch();
      if (!intentionallyDisconnectedSockets.has(connection) && !connectError) connectError = "F2000 disconnected unexpectedly. Reconnecting…";
      clearDeviceSessionState();
      notifyStatus();
      if (!connected) failInitial(new Error(connectError ?? "Connection closed before it could be established."));
      scheduleReconnect();
    });
  });
}

function scheduleReconnect(): void {
  if (!desiredConnected || !targetHost || targetPort === null || reconnectTimer || (connectingSocket && !connectingSocket.destroyed)) return;
  const host = targetHost, port = targetPort, epoch = connectionEpoch;
  reconnectAttempt++;
  reconnectAt = Date.now() + RECONNECT_DELAY_MS;
  notifyStatus();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null; reconnectAt = null;
    if (!desiredConnected || connectionEpoch !== epoch || (socket && !socket.destroyed) || (connectingSocket && !connectingSocket.destroyed)) return;
    void createConnection(host, port, epoch, false);
  }, RECONNECT_DELAY_MS);
}

function clearReconnectTimer(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null; reconnectAt = null;
}

function armHeartbeatWatch(): void {
  clearHeartbeatWatch();
  heartbeatTimer = setTimeout(() => {
    if (socket && !socket.destroyed && !lastHeartbeatAt) {
      connectError = `No F2000 heartbeat was received within ${HEARTBEAT_TIMEOUT_MS / 1000} seconds. Check the selected address and device network.`;
      notifyStatus();
    }
  }, HEARTBEAT_TIMEOUT_MS);
}

function clearHeartbeatWatch(): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
}

function resetConnectionState(): void {
  deviceIp = null; targetPort = null; reconnectAttempt = 0; clearHeartbeatWatch(); clearDeviceSessionState(); connectError = null;
}

function clearDeviceSessionState(): void {
  machineId = null; lastPassingAt = null; passingCount = 0; lastHeartbeatAt = null;
  batteryPercent = null; totalTagsRead = null; differentTagsRead = null; reader1Working = null; reader2Working = null;
  eventId = null; recvBuffer = ""; commandSerialNumber = 0; reader1State = "unknown"; reader2State = "unknown"; configApplied = false; lastReaderOpenRequestAt = 0;
}

function processPackets(onPassing?: ActiveTransponderPassingCallback): void {
  let delimiterIndex: number;
  while ((delimiterIndex = recvBuffer.indexOf(";")) >= 0) {
    const packet = recvBuffer.slice(0, delimiterIndex).trim(); recvBuffer = recvBuffer.slice(delimiterIndex + 1);
    if (packet) processPacket(packet, onPassing);
  }
}

function processPacket(packet: string, onPassing?: ActiveTransponderPassingCallback): void {
  const parts = packet.split("@");
  if (parts.length < 4) return;
  const [packetMachineId, command, , ...parameterParts] = parts;
  if (!packetMachineId || !command) return;
  if (!machineId) { machineId = packetMachineId; applyConfiguration(); }
  const parameters = parameterParts.join("@");
  if (command === "epc") processEpc(parameters, onPassing);
  else if (command === "heartBeat") {
    lastHeartbeatAt = new Date().toISOString();
    if (connectError?.startsWith("No F2000 heartbeat")) connectError = null;
    armHeartbeatWatch();
  }
  else if (command === "machineState") processMachineState(parameters);
  // An F2000 can ignore readerOpen while it is applying configuration. Keep
  // retrying after device packets until loop telemetry confirms it is working.
  syncReaders();
  notifyStatus();
}

function processEpc(parameters: string, onPassing?: ActiveTransponderPassingCallback): void {
  const commaIndex = parameters.indexOf(",");
  if (commaIndex < 1) return;
  const timestamp = parseFeibotTimestamp(parameters.slice(0, commaIndex).trim());
  const epc = parameters.slice(commaIndex + 1).trim();
  if (!timestamp || !epc) return;
  lastPassingAt = timestamp.toISOString(); passingCount++; connectError = null;
  onPassing?.(epc, timestamp);
}

function processMachineState(parameters: string): void {
  const values = new Map<string, string>();
  for (const item of parameters.split(",")) {
    const separator = item.indexOf("="); if (separator > 0) values.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  batteryPercent = parseOptionalNumber(values.get("batteryPercent")); totalTagsRead = parseOptionalNumber(values.get("totalTagsRead"));
  differentTagsRead = parseOptionalNumber(values.get("differentTagsRead")); reader1Working = values.get("reader1Working") ?? null;
  reader2Working = values.get("reader2Working") ?? null; eventId = values.get("eventId") ?? null;
}

function parseOptionalNumber(value: string | undefined): number | null {
  const parsed = Number(value);
  return value === undefined || value === "" || !Number.isFinite(parsed) ? null : parsed;
}

function parseFeibotTimestamp(value: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms = "0"] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, "0")));
  return date.getFullYear() === Number(y) && date.getMonth() === Number(mo) - 1 && date.getDate() === Number(d) && date.getHours() === Number(h) && date.getMinutes() === Number(mi) && date.getSeconds() === Number(s) ? date : null;
}

function readersShouldBeOpen(): boolean { return localReaderActive || testActive; }
function syncReaders(): void {
  if (readersShouldBeOpen()) openReaders(); else stopReaders();
  if (desiredConnected && (!socket || socket.destroyed) && (!connectingSocket || connectingSocket.destroyed)) scheduleReconnect();
}
function openReaders(): void {
  if (!socket || socket.destroyed || !machineId || !configApplied) return;
  const shouldRetry = Date.now() - lastReaderOpenRequestAt >= READER_OPEN_RETRY_MS;
  const needsReader1 = configuration.loopEnabled[0] && (reader1State !== "open" || !isWorking(reader1Working));
  const needsReader2 = configuration.loopEnabled[1] && (reader2State !== "open" || !isWorking(reader2Working));
  if (!needsReader1 && !needsReader2) return;
  if (!shouldRetry && reader1State === "open" && reader2State === "open") return;
  if (needsReader1) {
    sendReaderCommand("readerOpen", 1); reader1State = "open";
  }
  if (needsReader2) {
    sendReaderCommand("readerOpen", 2); reader2State = "open";
  }
  lastReaderOpenRequestAt = Date.now();
}
function stopReaders(): void {
  sendReaderCommand("readerStop", 1); sendReaderCommand("readerStop", 2); reader1State = "closed"; reader2State = "closed"; lastReaderOpenRequestAt = 0;
}
function sendReaderCommand(command: "readerOpen" | "readerStop", reader: 1 | 2): void {
  sendCommand(command, String(reader));
}
function sendCommand(command: string, parameters: string): void {
  if (!socket || socket.destroyed || !machineId) return;
  const serial = String(commandSerialNumber++ % 10_000).padStart(4, "0");
  socket.write(`${machineId}@${command}@${serial}@${parameters};`);
}
function applyConfiguration(): void {
  if (!socket || socket.destroyed || !machineId) return;
  // These must precede readerOpen on every freshly identified connection.
  sendCommand("setActiveChannel", String(configuration.activeChannel));
  sendCommand("setActivePower", String(configuration.activePower));
  sendCommand(configuration.loopEnabled[0] ? "loopEnable" : "loopDisable", "1");
  sendCommand(configuration.loopEnabled[1] ? "loopEnable" : "loopDisable", "2");
  configApplied = true;
  reader1State = "closed";
  reader2State = "closed";
  lastReaderOpenRequestAt = 0;
  syncReaders();
}
function validateConfiguration(config: ActiveTransponderConfiguration): void {
  if (!Number.isInteger(config.activeChannel) || config.activeChannel < 0 || config.activeChannel > 5) {
    throw new Error("F2000 active channel must be an integer from 0 to 5.");
  }
  if (!Number.isInteger(config.activePower) || config.activePower < 0 || config.activePower > 100) {
    throw new Error("F2000 active power must be an integer from 0 to 100.");
  }
  if (!Array.isArray(config.loopEnabled) || config.loopEnabled.length !== 2 || config.loopEnabled.some((value) => typeof value !== "boolean")) {
    throw new Error("F2000 loop settings must specify enabled/disabled values for loops 1 and 2.");
  }
}
function isWorking(value: string | null): boolean {
  return value !== null && ["1", "true", "working", "open", "enabled"].includes(value.toLowerCase());
}
function areEnabledLoopsTelemetryReady(): boolean {
  return (!configuration.loopEnabled[0] || (reader1State === "open" && isWorking(reader1Working))) &&
    (!configuration.loopEnabled[1] || (reader2State === "open" && isWorking(reader2Working)));
}
function getState(connected: boolean): ActiveTransponderConnectionState {
  if (!desiredConnected) return "disconnected";
  if (connectError && !connected && !connectingSocket && !reconnectTimer) return "error";
  if (reconnectTimer || (connectingSocket && reconnectAttempt > 0)) return "reconnecting";
  if (connectingSocket) return "connecting";
  if (connectError) return "error";
  if (testActive) return "testing";
  if (localReaderActive) return "race_active";
  return connected ? "connected_idle" : "connecting";
}
function getDiagnosis(state: ActiveTransponderConnectionState): string {
  if (state === "disconnected") return "Disconnected. Enter the F2000 address (port 55555 is used when no port is supplied).";
  if (state === "connecting") return "Connecting to the F2000. Waiting for its first heartbeat to identify the machine.";
  if (state === "reconnecting") return `F2000 connection dropped; retry ${reconnectAttempt} is scheduled. Reader intent will resume after reconnecting.`;
  if (state === "error") return connectError ?? "F2000 requires attention. Check its address, network, and heartbeat.";
  if (!machineId) return "TCP connected; waiting for the F2000 heartbeat before loop settings can be applied.";
  if (!configApplied) return "F2000 is not ready: applying saved loop, channel, and power settings.";
  if (readersShouldBeOpen() && !areEnabledLoopsTelemetryReady()) return "F2000 is not ready: enabled loops were opened and are waiting for reader telemetry confirmation.";
  if (state === "testing") return lastPassingAt ? "Both loops are open for testing; a real F2000 crossing was observed." : "Both loops are open for testing. Pass a tagged transponder over a loop to verify it.";
  if (state === "race_active") return "Local moto/practice reader state is active; both F2000 loops are open.";
  return "Connected and idle; loops are closed until a moto, practice, or loop test starts.";
}
function notifyStatus(): void { statusCallback?.(getActiveTransponderStatus()); }