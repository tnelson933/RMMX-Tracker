/**
 * RM Connect — main process.
 *
 * A tray-only Electron app that bridges local timing hardware to the cloud.
 * One laptop can run several readers at once (a finish line plus split or
 * section readers), each with its own ReaderSession:
 *   - LLRP RFID readers (Impinj R700, Zebra, others) on TCP 5084
 *   - RM TrackR active timing readers on TCP 55555
 *
 * Crossings are forwarded to the cloud ingest endpoint. Start/stop commands
 * arrive over a WebSocket when the organizer starts or completes a moto in
 * the web app.
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import fs from "fs";
import os from "os";
import dns from "dns";
import path from "path";
import { pathToFileURL } from "url";
import { ReaderSession } from "./reader-session";
import { scanLocalNetwork, probeAddress, type DiscoveredDevice } from "./discovery";
import { pairLaptop, fetchReaders, createReader, updateReader, type CloudReader } from "./cloud";
import {
  loadSettings,
  saveSettings,
  saveLaptopKey,
  loadLaptopKey,
  clearLaptopKey,
  clearLegacyCredentials,
  clearAll,
  type ConnectorSettings,
  type ReaderConfig,
  type ActiveTimingConfig,
} from "./auth-manager";
import { DEFAULT_ACTIVE_TIMING } from "./settings-migrations";
import { builtInCloudUrl, normalizeCloudUrl } from "./cloud-url";
import { ICON_GREEN, ICON_RED, ICON_GRAY } from "./tray-icons";
import type { AppStatus, AddReaderInput, ActionResult, CloudReaderSummary, LoginResult, ScanReply } from "./ipc-types";

// ── State ─────────────────────────────────────────────────────────────────────

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
declare const __CONNECTOR_PACKAGE_VERSION__: string;

// loadSettings() fills in the built-in cloud URL, migrates retired hosts, and
// turns an older single-reader settings file into a reader list.
let settings: ConnectorSettings = loadSettings();
const sessions = new Map<number, ReaderSession>();
let identifying = false;
let identifyTimer: NodeJS.Timeout | null = null;
const IDENTIFY_TIMEOUT_MS = 2 * 60_000;

function getConnectorVersion(): string {
  try {
    const electronVersion = app.getVersion();
    if (electronVersion) return electronVersion;
  } catch {
    // Fall through to the package version embedded by the connector build.
  }
  return typeof __CONNECTOR_PACKAGE_VERSION__ === "string" && __CONNECTOR_PACKAGE_VERSION__
    ? __CONNECTOR_PACKAGE_VERSION__
    : "unknown";
}

function queueFile(readerId: number): string {
  return path.join(app.getPath("userData"), `pending-crossings-${readerId}.json`);
}

/** Releases before 1.0.18 kept one queue file; hand it to the first reader. */
function adoptLegacyQueue(readerId: number): void {
  const legacy = path.join(app.getPath("userData"), "pending-crossings.json");
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(queueFile(readerId))) fs.renameSync(legacy, queueFile(readerId));
  } catch {
    // Non-fatal: the old file stays where it is.
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

function getAppStatus(): AppStatus {
  return {
    signedIn: !!laptopKey,
    signInRequired: pairingRequired,
    email: settings.clubName,
    cloudUrl: settings.cloudUrl,
    readers: settings.readers.map(r => sessions.get(r.readerId)?.getStatus()).filter((s): s is NonNullable<typeof s> => !!s),
    identifying,
  };
}

let pushQueued = false;
function pushStatus(): void {
  // Coalesce bursts of read events into one window update.
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("status:update", getAppStatus());
    }
    updateTray();
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function trayIcon(): Electron.NativeImage {
  const readers = getAppStatus().readers;
  const base64 = readers.length === 0
    ? ICON_GRAY
    : readers.every(r => r.cloud.connected && r.device.connected) ? ICON_GREEN : ICON_RED;
  return nativeImage.createFromDataURL(`data:image/png;base64,${base64}`);
}

function trayStatusLabel(): string {
  const readers = getAppStatus().readers;
  if (readers.length === 0) return "No readers set up";
  const connected = readers.filter(r => r.device.connected).length;
  const racing = readers.find(r => r.activeMoto)?.activeMoto;
  const label = `${connected} of ${readers.length} reader${readers.length === 1 ? "" : "s"} connected`;
  return racing ? `${label} — timing ${racing.name}` : label;
}

function updateTray(): void {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(`RM Connect — ${trayStatusLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayStatusLabel(), enabled: false },
      { type: "separator" },
      { label: "Open RM Connect", click: () => openSettingsWindow() },
      { type: "separator" },
      { label: "Quit RM Connect", click: () => { app.quit(); } },
    ]),
  );
}

// ── Settings window ───────────────────────────────────────────────────────────

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 520,
    resizable: true,
    title: "RM Connect",
    icon: path.join(__dirname, "ui", "logo.png"),
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  // The settings page is a local file and never navigates or opens windows.
  // Links that should open go through the openExternal IPC (http/https only).
  // (location.reload() of the settings page itself stays allowed.)
  const settingsPage = path.join(__dirname, "ui", "settings.html");
  const settingsPageUrl = pathToFileURL(settingsPage).href;
  const normalizeFileUrl = (url: string) => {
    try { return decodeURIComponent(url.split(/[?#]/)[0]).toLowerCase(); } catch { return url.toLowerCase(); }
  };
  const isSettingsPage = (url: string) => normalizeFileUrl(url) === normalizeFileUrl(settingsPageUrl);
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  settingsWindow.webContents.on("will-navigate", (event, url) => {
    if (!isSettingsPage(url)) event.preventDefault();
  });
  settingsWindow.webContents.on("will-redirect", (event, url) => {
    if (!isSettingsPage(url)) event.preventDefault();
  });
  settingsWindow.loadFile(settingsPage);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── Sessions ──────────────────────────────────────────────────────────────────

function saveReaderConfig(config: ReaderConfig): void {
  settings = {
    ...settings,
    readers: settings.readers.some(r => r.readerId === config.readerId)
      ? settings.readers.map(r => (r.readerId === config.readerId ? config : r))
      : [...settings.readers, config],
  };
  saveSettings(settings);
}

function startSession(config: ReaderConfig): ReaderSession {
  sessions.get(config.readerId)?.dispose();
  const session = new ReaderSession({
    config,
    cloudUrl: settings.cloudUrl,
    clubId: settings.clubId,
    connectorVersion: getConnectorVersion(),
    queueFile: queueFile(config.readerId),
    rediscover: findMovedReader,
  });
  session.on("change", pushStatus);
  session.on("addressChanged", (address: string) => {
    saveReaderConfig(session.config);
    // Keep RM Roost's copy in step so the next laptop finds it too.
    withSession(cookie => updateReader(settings.cloudUrl, cookie, session.config.readerId, { name: session.config.readerName, hardwareAddress: address }))
      .catch(() => {});
  });
  session.on("activeTimingChanged", () => saveReaderConfig(session.config));
  sessions.set(config.readerId, session);
  if (identifying) session.setIdentifying(true);
  session.start();
  return session;
}

function stopAllSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}

/** Resolve a host name (e.g. impinj-xx-xx-xx.local) to its IP; null if it can't be found quickly. */
function resolveHost(host: string): Promise<string | null> {
  const bare = host.replace(/:\d+$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return Promise.resolve(bare);
  return Promise.race([
    dns.promises.lookup(bare, { family: 4 }).then(r => r.address).catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
  ]);
}

/**
 * IPs of devices this laptop's readers use. Scans skip them (a reader takes
 * one client, so even a probe can disturb it), and Find readers marks them
 * "Already added", including readers saved by name rather than IP.
 */
async function addressesInUse(): Promise<Map<string, string>> {
  const used = new Map<string, string>(); // ip → reader name
  await Promise.all([...sessions.values()].map(async (s) => {
    for (const host of [s.connectedAddress(), s.host]) {
      if (!host) continue;
      const ip = await resolveHost(host);
      if (ip) used.set(ip, s.config.readerName);
    }
  }));
  return used;
}

/**
 * Called after a reader has failed to reconnect several times. If exactly one
 * unclaimed device of the same kind is on the network, the reader most likely
 * moved there (a router restart handed out new addresses). Devices registered
 * to other readers in RM Roost, and this laptop's own, are never candidates.
 */
let rediscovery: Promise<string | null> | null = null;
function findMovedReader(session: ReaderSession): Promise<string | null> {
  // One network scan at a time, however many readers are retrying.
  rediscovery ??= (async () => {
    const used = await addressesInUse();
    const cloudReaders = await withSession(key => fetchReaders(settings.cloudUrl, key)).catch(() => [] as CloudReader[]);
    const claimed = new Set<string>();
    for (const r of cloudReaders) {
      if (r.id === session.config.readerId || !r.hardwareAddress) continue;
      const ip = await resolveHost(r.hardwareAddress);
      if (ip) claimed.add(ip);
    }
    const { devices } = await scanLocalNetwork([...used.keys()]);
    const wantActive = session.config.hardware === "active_transponder";
    const candidates = devices.filter(d => (d.hardware === "active_transponder") === wantActive && !claimed.has(d.address.replace(/:\d+$/, "")));
    return candidates.length === 1 ? candidates[0].address : null;
  })().finally(() => { rediscovery = null; });
  return rediscovery;
}

// ── Identify ──────────────────────────────────────────────────────────────────

function setIdentifying(enabled: boolean): void {
  identifying = enabled;
  if (identifyTimer) clearTimeout(identifyTimer);
  identifyTimer = enabled ? setTimeout(() => setIdentifying(false), IDENTIFY_TIMEOUT_MS) : null;
  for (const s of sessions.values()) s.setIdentifying(enabled);
  pushStatus();
}

// ── Laptop pairing ────────────────────────────────────────────────────────────

// The laptop is paired with RM Roost once (a 6-digit code from Reader Setup)
// and uses its own laptop key from then on. No organizer password is stored.
// If RM Roost stops accepting the key (the laptop was removed on Reader Setup),
// RM Connect asks for a new code; readers keep timing meanwhile because they
// use their own reader tokens.
let laptopKey: string | null = null;
let pairingRequired: string | null = null;

function requirePairing(reason: string): never {
  pairingRequired = reason;
  pushStatus();
  throw new Error(reason);
}

/** Run a call that needs the laptop key; a rejected key asks for a new code. */
async function withSession<T>(fn: (key: string) => Promise<T>): Promise<T> {
  if (pairingRequired) throw new Error(pairingRequired);
  if (!laptopKey) return requirePairing("Connect this laptop to RM Roost with a pairing code from Reader Setup.");
  try {
    return await fn(laptopKey);
  } catch (err: any) {
    if (err?.status === 401) {
      laptopKey = null;
      clearLaptopKey();
      return requirePairing("RM Roost no longer recognizes this laptop (it was removed on Reader Setup). Enter a new pairing code. Your readers keep timing.");
    }
    throw err;
  }
}

function summarize(readers: CloudReader[]): CloudReaderSummary[] {
  return readers.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    hardwareAddress: r.hardwareAddress ?? null,
    onThisLaptop: sessions.has(r.id),
  }));
}

function sameAddress(a: string | null | undefined, b: string): boolean {
  const strip = (v: string) => v.trim().toLowerCase().replace(/:55555$/, "");
  return !!a && strip(a) === strip(b);
}

function defaultReaderName(device: Pick<DiscoveredDevice, "hardware">, existing: CloudReader[]): string {
  const base = device.hardware === "active_transponder" ? "RM TrackR" : "RFID Reader";
  const taken = new Set(existing.map(r => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle("status:get", () => getAppStatus());

  ipcMain.handle("settings:get", () => ({
    cloudUrl: settings.cloudUrl,
    clubName: settings.clubName,
    laptopName: os.hostname(),
    readers: settings.readers.map(r => ({ readerId: r.readerId, activeTiming: r.activeTiming })),
  }));

  ipcMain.handle(
    "auth:pair",
    async (_e, input: { cloudUrl: string; code: string; laptopName: string }): Promise<LoginResult> => {
      try {
        // A blank field means the built-in RM Roost cloud; "host.com" gets https://.
        const cloudUrl = normalizeCloudUrl(input.cloudUrl) || builtInCloudUrl();
        if (!/^https?:\/\//i.test(cloudUrl)) throw new Error("Server address must start with https:// (or http:// for a local server)");
        const paired = await pairLaptop(cloudUrl, input.code, input.laptopName?.trim() || os.hostname());
        // Readers belong to one club on one RM Roost server; don't carry them elsewhere.
        // An older install may not know its club yet (null): same readers, keep them.
        if (cloudUrl !== settings.cloudUrl || (settings.clubId != null && paired.clubId !== settings.clubId)) {
          stopAllSessions();
          settings = { ...settings, readers: [] };
        }
        if (!saveLaptopKey(paired.laptopKey)) {
          throw new Error("This computer can't store the laptop key securely (its keychain isn't available), so the connection wouldn't survive a restart. Sign in to Windows or macOS normally and try again.");
        }
        laptopKey = paired.laptopKey;
        pairingRequired = null;
        settings = { ...settings, cloudUrl, clubId: paired.clubId, clubName: paired.clubName ?? "" };
        saveSettings(settings);
        pushStatus();
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? "Pairing failed" };
      }
    },
  );

  ipcMain.handle("readers:cloud", async () => {
    try {
      return { ok: true, readers: summarize(await withSession(cookie => fetchReaders(settings.cloudUrl, cookie))) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Couldn't load your readers from RM Roost" };
    }
  });

  ipcMain.handle("network:scan", async (): Promise<ScanReply> => {
    try {
      const [scan, cloudReaders] = await Promise.all([
        addressesInUse().then(used => scanLocalNetwork([...used.keys()])),
        withSession(cookie => fetchReaders(settings.cloudUrl, cookie)).catch(() => [] as CloudReader[]),
      ]);
      return {
        ok: true,
        scannedHosts: scan.scannedHosts,
        devices: scan.devices.map(d => {
          const local = settings.readers.find(r => sameAddress(r.hardwareAddress, d.address));
          const registered = cloudReaders.find(r => sameAddress(r.hardwareAddress, d.address)
            && (r.type === "active_transponder") === (d.hardware === "active_transponder"));
          return { ...d, inUseBy: local?.readerName ?? null, registeredReaderId: registered?.id ?? null };
        }),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Network scan failed" };
    }
  });

  ipcMain.handle("network:probe", async (_e, address: string): Promise<ScanReply> => {
    try {
      if (typeof address !== "string" || !address.trim()) throw new Error("Enter an address");
      const { resolved, devices } = await probeAddress(address);
      if (!resolved) return { ok: false, error: `Couldn't find "${address.trim()}" on this network. Check the spelling, or that the device is powered and plugged in.` };
      if (devices.length === 0) {
        return { ok: false, error: `${resolved} answered, but not as a timing reader. RFID readers need LLRP turned on (port 5084); the RM TrackR must be in TCP mode (port 55555).` };
      }
      const cloudReaders = await withSession(cookie => fetchReaders(settings.cloudUrl, cookie)).catch(() => [] as CloudReader[]);
      return {
        ok: true,
        devices: devices.map(d => ({
          ...d,
          inUseBy: settings.readers.find(r => sameAddress(r.hardwareAddress, d.address))?.readerName ?? null,
          registeredReaderId: cloudReaders.find(r => sameAddress(r.hardwareAddress, d.address))?.id ?? null,
        })),
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Check failed" };
    }
  });

  ipcMain.handle("reader:add", async (_e, input: AddReaderInput): Promise<ActionResult> => {
    try {
      const address = input.address.trim();
      if (!address) throw new Error("No device address");
      const type = input.hardware === "active_transponder" ? "active_transponder" : "rfid";
      const cloudReaders = await withSession(cookie => fetchReaders(settings.cloudUrl, cookie));
      let reader: CloudReader | undefined;
      if (input.readerId) {
        reader = cloudReaders.find(r => r.id === input.readerId);
        if (!reader) throw new Error("That reader no longer exists in RM Roost — pick another or add it as new.");
        if (reader.type !== type) throw new Error(`"${reader.name}" is set up as ${reader.type === "rfid" ? "an RFID reader" : "an RM TrackR"} in RM Roost, but this device is ${type === "rfid" ? "an RFID reader" : "an RM TrackR"}.`);
        if (sessions.has(reader.id)) throw new Error(`"${reader.name}" is already connected on this laptop.`);
        reader = await withSession(cookie => updateReader(settings.cloudUrl, cookie, reader!.id, { name: reader!.name, hardwareAddress: address }));
      } else {
        const name = input.name?.trim() || defaultReaderName({ hardware: input.hardware }, cloudReaders);
        reader = await withSession(cookie => createReader(settings.cloudUrl, cookie, { name, type, hardwareAddress: address }));
      }
      const config: ReaderConfig = {
        readerId: reader.id,
        readerToken: reader.token,
        readerName: reader.name,
        hardware: input.hardware,
        hardwareAddress: address,
        activeTiming: reader.activeTimingConfig ?? { ...DEFAULT_ACTIVE_TIMING },
      };
      if (settings.readers.length === 0) adoptLegacyQueue(config.readerId);
      saveReaderConfig(config);
      startSession(config);
      pushStatus();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Couldn't add the reader" };
    }
  });

  ipcMain.handle("reader:remove", (_e, readerId: number): ActionResult => {
    sessions.get(readerId)?.dispose();
    sessions.delete(readerId);
    settings = { ...settings, readers: settings.readers.filter(r => r.readerId !== readerId) };
    saveSettings(settings);
    pushStatus();
    return { ok: true };
  });

  ipcMain.handle("reader:rename", async (_e, readerId: number, name: string): Promise<ActionResult> => {
    try {
      const config = settings.readers.find(r => r.readerId === readerId);
      const trimmed = typeof name === "string" ? name.trim() : "";
      if (!config) throw new Error("Reader not found");
      if (!trimmed) throw new Error("Enter a name");
      await withSession(cookie => updateReader(settings.cloudUrl, cookie, readerId, { name: trimmed }));
      const updated = { ...config, readerName: trimmed };
      saveReaderConfig(updated);
      sessions.get(readerId)?.update(updated);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Couldn't rename the reader" };
    }
  });

  ipcMain.handle("reader:reconnect", async (_e, readerId: number): Promise<ActionResult> => {
    const session = sessions.get(readerId);
    if (!session) return { ok: false, error: "Reader not found" };
    try {
      await session.reconnect();
      return { ok: true };
    } catch {
      // The session keeps retrying; its status carries the plain-English reason.
      return { ok: false, error: session.getStatus().device.diagnosis ?? "Couldn't connect" };
    }
  });

  ipcMain.handle("reader:test", async (_e, readerId: number, enabled: boolean): Promise<ActionResult> => {
    const session = sessions.get(readerId);
    if (!session) return { ok: false, error: "Reader not found" };
    await session.setTestMode(!!enabled);
    return { ok: true };
  });

  ipcMain.handle("reader:configure", async (_e, readerId: number, input: ActiveTimingConfig & { syncClock?: boolean }): Promise<ActionResult> => {
    try {
      const session = sessions.get(readerId);
      if (!session || session.config.hardware !== "active_transponder") throw new Error("RM TrackR settings only apply to an RM TrackR reader.");
      if (!Number.isInteger(input.channel) || input.channel < 0 || input.channel > 5) throw new Error("Channel must be a whole number from 0 to 5.");
      if (!Number.isInteger(input.power) || input.power < 0 || input.power > 100) throw new Error("Power must be a whole number from 0 to 100.");
      if (!input.loop1Enabled && !input.loop2Enabled) throw new Error("Keep at least one loop on.");
      if (input.syncClock && !session.getStatus().device.machineId) {
        throw new Error("The RM TrackR hasn't identified itself yet. Wait for its ID to show on the card, then sync the clock.");
      }
      session.setActiveTiming({ channel: input.channel, power: input.power, loop1Enabled: !!input.loop1Enabled, loop2Enabled: !!input.loop2Enabled }, !!input.syncClock);
      saveReaderConfig(session.config);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Couldn't apply the settings." };
    }
  });

  ipcMain.handle("identify:set", (_e, enabled: boolean) => {
    setIdentifying(!!enabled);
    return { ok: true };
  });

  ipcMain.handle("logout", () => {
    setIdentifying(false);
    stopAllSessions();
    laptopKey = null;
    pairingRequired = null;
    clearAll();
    settings = loadSettings();
    pushStatus();
    return { ok: true };
  });

  ipcMain.handle("open-external", (_e, url: string) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => openSettingsWindow());

  app.whenReady().then(async () => {
    // Tray-only app: no dock icon on macOS
    if (process.platform === "darwin" && app.dock) app.dock.hide();

    tray = new Tray(trayIcon());
    tray.on("double-click", () => openSettingsWindow());
    updateTray();
    registerIpc();

    laptopKey = loadLaptopKey();
    // Older releases kept an organizer password here; it is no longer used.
    clearLegacyCredentials();

    // Keep "retry in Ns" and "last read Ns ago" fresh in the window.
    setInterval(() => pushStatus(), 2_000);

    if (settings.readers.length > 0 && settings.autoConnect) {
      adoptLegacyQueue(settings.readers[0].readerId);
      for (const config of settings.readers) startSession(config);
    } else {
      openSettingsWindow();
    }
  });

  // Keep running when all windows are closed — we live in the tray
  app.on("window-all-closed", () => {
    /* no-op */
  });

  app.on("before-quit", () => {
    stopAllSessions();
  });
}
