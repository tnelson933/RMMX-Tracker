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
import path from "path";
import { pathToFileURL } from "url";
import { ReaderSession } from "./reader-session";
import { scanLocalNetwork, probeAddress, type DiscoveredDevice } from "./discovery";
import { cloudLogin, fetchReaders, createReader, updateReader, type CloudReader } from "./cloud";
import {
  loadSettings,
  saveSettings,
  savePassword,
  loadPassword,
  clearPassword,
  saveSessionCookie,
  loadSessionCookie,
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
let sessionCookie: string | null = null;
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
    signedIn: !!settings.email,
    signInRequired,
    email: settings.email,
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

/** Addresses of devices this laptop is connected to, which a scan must not probe. */
function addressesInUse(): string[] {
  const used = new Set<string>();
  for (const s of sessions.values()) {
    const connected = s.connectedAddress();
    if (connected) used.add(connected);
    used.add(s.host.replace(/:\d+$/, ""));
  }
  return [...used];
}

/**
 * Called after a reader has failed to reconnect several times. If exactly one
 * unclaimed device of the same kind is on the network, the reader most likely
 * moved there (a router restart handed out new addresses).
 */
async function findMovedReader(session: ReaderSession): Promise<string | null> {
  const { devices } = await scanLocalNetwork(addressesInUse());
  const wantActive = session.config.hardware === "active_transponder";
  const candidates = devices.filter(d => (d.hardware === "active_transponder") === wantActive);
  if (candidates.length !== 1) return null;
  return candidates[0].address;
}

// ── Identify ──────────────────────────────────────────────────────────────────

function setIdentifying(enabled: boolean): void {
  identifying = enabled;
  if (identifyTimer) clearTimeout(identifyTimer);
  identifyTimer = enabled ? setTimeout(() => setIdentifying(false), IDENTIFY_TIMEOUT_MS) : null;
  for (const s of sessions.values()) s.setIdentifying(enabled);
  pushStatus();
}

// ── Cloud session ─────────────────────────────────────────────────────────────

// When the saved password stops working, RM Connect asks the organizer to sign
// in again instead of retrying it: repeated automatic tries would only trip
// RM Roost's sign-in limit. Readers keep timing meanwhile (they use their own
// reader tokens, not this session).
let signInRequired: string | null = null;
let sessionRefresh: Promise<string> | null = null;

/** Return a valid session cookie, signing in once with the saved password if needed. */
function ensureSession(): Promise<string> {
  if (signInRequired) return Promise.reject(new Error(signInRequired));
  // Several actions can need the session at once; share one sign-in.
  sessionRefresh ??= refreshSession().finally(() => { sessionRefresh = null; });
  return sessionRefresh;
}

async function refreshSession(): Promise<string> {
  if (sessionCookie) {
    try {
      await fetchReaders(settings.cloudUrl, sessionCookie);
      return sessionCookie;
    } catch (err: any) {
      // Only an expired session means signing in again; a network problem doesn't.
      if (err?.status !== 401) throw err;
      sessionCookie = null;
    }
  }
  const password = loadPassword();
  if (!settings.cloudUrl || !settings.email || !password) {
    return requireSignIn("Sign in to RM Roost again to add or rename readers.");
  }
  try {
    const { cookie } = await cloudLogin(settings.cloudUrl, settings.email, password);
    sessionCookie = cookie;
    saveSessionCookie(cookie);
    return cookie;
  } catch (err: any) {
    if (err?.status === 401 || err?.status === 403) {
      clearPassword();
      return requireSignIn("RM Roost didn't accept the saved password (it may have changed). Sign in again to add or rename readers. Your readers keep timing.");
    }
    if (err?.status === 429) return requireSignIn(err.message);
    throw err;
  }
}

function requireSignIn(reason: string): never {
  signInRequired = reason;
  sessionCookie = null;
  pushStatus();
  throw new Error(reason);
}

async function withSession<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  return fn(await ensureSession());
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
    email: settings.email,
    readers: settings.readers.map(r => ({ readerId: r.readerId, activeTiming: r.activeTiming })),
  }));

  ipcMain.handle(
    "auth:login",
    async (_e, input: { cloudUrl: string; email: string; password: string }): Promise<LoginResult> => {
      try {
        // A blank field means the built-in RM Roost cloud; "host.com" gets https://.
        const cloudUrl = normalizeCloudUrl(input.cloudUrl) || builtInCloudUrl();
        if (!/^https?:\/\//i.test(cloudUrl)) throw new Error("Server address must start with https:// (or http:// for a local server)");
        const { cookie, clubId } = await cloudLogin(cloudUrl, input.email.trim(), input.password);
        const cloudChanged = cloudUrl !== settings.cloudUrl;
        sessionCookie = cookie;
        signInRequired = null;
        settings = { ...settings, cloudUrl, email: input.email.trim(), clubId };
        if (cloudChanged) {
          // Readers belong to one RM Roost server; don't carry them to another.
          stopAllSessions();
          settings = { ...settings, readers: [] };
        }
        saveSettings(settings);
        savePassword(input.password);
        saveSessionCookie(cookie);
        pushStatus();
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? "Sign-in failed" };
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
        scanLocalNetwork(addressesInUse()),
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
    sessionCookie = null;
    signInRequired = null;
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

    sessionCookie = loadSessionCookie();

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
