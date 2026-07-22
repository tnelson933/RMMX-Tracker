/**
 * RM Connect — main process.
 *
 * A tray-only Electron app that bridges local timing hardware to the cloud:
 *   - Impinj R700 via LLRP (TCP 5084, reached by mDNS hostname from MAC digits)
 *   - MyLaps / AMB decoder via AMBrc protocol (TCP 3601)
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
import path from "path";
import { LlrpClient, impinjHostFromMac } from "./llrp";
import { MyLapsClient } from "./mylaps";
import {
  CloudLink,
  cloudLogin,
  fetchReaders,
  type CloudCommand,
} from "./cloud";
import {
  loadSettings,
  saveSettings,
  savePassword,
  loadPassword,
  saveSessionCookie,
  loadSessionCookie,
  clearAll,
  type ConnectorSettings,
} from "./auth-manager";
import { ICON_GREEN, ICON_RED, ICON_GRAY } from "./tray-icons";
import type { AggregateStatus, ConnectInput, LoginResult } from "./ipc-types";

// ── State ─────────────────────────────────────────────────────────────────────

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
declare const __DEFAULT_CLOUD_URL__: string;

let settings: ConnectorSettings = loadSettings();
if (!settings.cloudUrl && __DEFAULT_CLOUD_URL__) {
  settings.cloudUrl = __DEFAULT_CLOUD_URL__.replace(/\/+$/, "");
}
let sessionCookie: string | null = null;

const llrp = new LlrpClient();
const mylaps = new MyLapsClient();
const cloud = new CloudLink();

let activeMoto: { motoId: number; name: string } | null = null;
let testMode = false;
let deviceReconnectTimer: NodeJS.Timeout | null = null;
let hardwareWanted = false; // true while the user wants the device connected

// EPC → last forward time, for local debounce (server also debounces)
const recentReads = new Map<string, number>();
const LOCAL_DEDUPE_MS = 1_500;

// ── Status aggregation ────────────────────────────────────────────────────────

function getAggregateStatus(): AggregateStatus {
  const isLlrp = settings.hardware === "impinj" || settings.hardware === "zebra" || settings.hardware === "generic";
  const dev = isLlrp ? llrp.getStatus() : null;
  const ml = settings.hardware === "mylaps" ? mylaps.getStatus() : null;

  return {
    configured: !!settings.readerToken && !!settings.hardware && !!settings.hardwareAddress,
    cloudUrl: settings.cloudUrl,
    email: settings.email,
    readerName: settings.readerName,
    hardware: settings.hardware,
    hardwareAddress: settings.hardwareAddress,
    cloud: {
      connected: cloud.getStatus().connected,
      error: cloud.getStatus().error,
    },
    device: {
      connected: dev?.connected ?? ml?.connected ?? false,
      reading: dev?.reading ?? (ml?.connected && (activeMoto !== null || testMode)) ?? false,
      error: dev?.error ?? ml?.error ?? null,
      lastReadAt: dev?.lastReadAt ?? ml?.lastPassingAt ?? null,
      readCount: dev?.readCount ?? ml?.passingCount ?? 0,
      antennaIds: dev?.antennaIds ?? [],
    },
    activeMoto,
    testMode,
  };
}

function pushStatusToWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("status:update", getAggregateStatus());
  }
  updateTray();
}

// ── Tray ──────────────────────────────────────────────────────────────────────

function trayIcon(): Electron.NativeImage {
  const s = getAggregateStatus();
  const base64 = !s.configured
    ? ICON_GRAY
    : s.cloud.connected && s.device.connected
      ? ICON_GREEN
      : ICON_RED;
  return nativeImage.createFromDataURL(`data:image/png;base64,${base64}`);
}

function trayStatusLabel(): string {
  const s = getAggregateStatus();
  if (!s.configured) return "Not configured";
  const dev = s.device.connected ? "Reader connected" : "Reader disconnected";
  const cl = s.cloud.connected ? "Cloud connected" : "Cloud disconnected";
  const moto = s.activeMoto ? ` — reading (${s.activeMoto.name})` : "";
  return `${dev} · ${cl}${moto}`;
}

function updateTray(): void {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(`RM Connect — ${trayStatusLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayStatusLabel(), enabled: false },
      { type: "separator" },
      { label: "Open Settings", click: () => openSettingsWindow() },
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
    width: 460,
    height: 640,
    minWidth: 400,
    minHeight: 500,
    resizable: true,
    title: "RM Connect",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "ui", "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

// ── Crossing forwarding ───────────────────────────────────────────────────────

function shouldForward(): boolean {
  return activeMoto !== null || testMode;
}

async function forwardCrossing(rfidNumber: string, crossingTime: Date, antennaId?: number | null): Promise<void> {
  if (!shouldForward()) return;

  const now = Date.now();
  const last = recentReads.get(rfidNumber);
  if (last !== undefined && now - last < LOCAL_DEDUPE_MS) return;
  recentReads.set(rfidNumber, now);
  // Bound the dedupe map
  if (recentReads.size > 2000) {
    for (const [k, t] of recentReads) {
      if (now - t > LOCAL_DEDUPE_MS) recentReads.delete(k);
    }
  }

  try {
    await cloud.postCrossing({ rfidNumber, crossingTime, antennaId, clubId: settings.clubId });
  } catch {
    // Network hiccup — the rider will cross again next lap; server-side
    // parity/debounce keeps state consistent. Cloud WS status shows red.
  }
}

llrp.on("tag", (read) => {
  forwardCrossing(read.epcHex, new Date(), read.antennaId).catch(() => {});
  pushStatusToWindow();
});

mylaps.on("passing", (transponder: string, crossingTime: Date) => {
  forwardCrossing(transponder, crossingTime).catch(() => {});
  pushStatusToWindow();
});

// ── Hardware connection management ────────────────────────────────────────────

function isLlrpHardware(): boolean {
  return settings.hardware === "impinj" || settings.hardware === "zebra" || settings.hardware === "generic";
}

function resolveHardwareHost(): string {
  const addr = settings.hardwareAddress.trim();
  if (settings.hardware === "impinj") {
    // Accept: last-6 MAC digits, full hostname, or IP
    if (/^[0-9a-fA-F]{6}$/.test(addr.replace(/[^0-9a-fA-F]/g, "")) && !addr.includes(".")) {
      return impinjHostFromMac(addr);
    }
    return addr;
  }
  return addr; // zebra/generic: hostname or IP · mylaps: decoder IP
}

async function connectHardware(): Promise<void> {
  hardwareWanted = true;
  const host = resolveHardwareHost();
  if (isLlrpHardware()) {
    await llrp.connect(host, { impinjExtensions: settings.hardware === "impinj" });
    // If a moto is already live (reconnect mid-race), resume reading
    if (shouldForward()) {
      await llrp.startReading().catch(() => {});
    }
  } else if (settings.hardware === "mylaps") {
    await mylaps.connect(host);
  }
  pushStatusToWindow();
}

function disconnectHardware(): void {
  hardwareWanted = false;
  if (deviceReconnectTimer) {
    clearTimeout(deviceReconnectTimer);
    deviceReconnectTimer = null;
  }
  llrp.disconnect().catch(() => {});
  mylaps.disconnect();
  pushStatusToWindow();
}

function scheduleHardwareReconnect(): void {
  if (!hardwareWanted || deviceReconnectTimer) return;
  deviceReconnectTimer = setTimeout(() => {
    deviceReconnectTimer = null;
    if (!hardwareWanted) return;
    connectHardware().catch(() => scheduleHardwareReconnect());
  }, 10_000);
}

llrp.on("disconnected", () => {
  pushStatusToWindow();
  scheduleHardwareReconnect();
});
llrp.on("error", () => pushStatusToWindow());
mylaps.on("disconnected", () => {
  pushStatusToWindow();
  scheduleHardwareReconnect();
});

// ── Cloud command handling ────────────────────────────────────────────────────

cloud.setStatusProvider(() => {
  const s = getAggregateStatus();
  return {
    hardware: settings.hardware,
    connected: s.device.connected,
    detail: s.device.error,
    lastReadAt: s.device.lastReadAt,
    readCount: s.device.readCount,
    antennaIds: s.device.antennaIds,
  };
});

cloud.on("command", (cmd: CloudCommand) => {
  if (cmd.type === "start_moto" && cmd.motoId) {
    activeMoto = { motoId: cmd.motoId, name: cmd.motoName ?? `Moto ${cmd.motoId}` };
    if (isLlrpHardware()) {
      llrp.startReading().catch(() => {
        // Reader not connected — reconnect loop will resume reading when back
        scheduleHardwareReconnect();
      });
    }
  } else if (cmd.type === "stop_moto") {
    activeMoto = null;
    if (isLlrpHardware() && !testMode) {
      llrp.stopReading().catch(() => {});
    }
  } else if (cmd.type === "set_llrp_config" && cmd.config && isLlrpHardware()) {
    llrp.applyRfConfig(cmd.config).catch(() => {
      // Non-fatal — config stored and will be applied on next reconnect
    });
  }
  cloud.sendStatus();
  pushStatusToWindow();
});

cloud.on("connected", pushStatusToWindow);
cloud.on("disconnected", pushStatusToWindow);

// ── Full connect / disconnect ─────────────────────────────────────────────────

async function connectAll(): Promise<void> {
  if (!settings.readerToken) throw new Error("No reader selected");
  if (!settings.hardware || !settings.hardwareAddress) throw new Error("Hardware not configured");
  cloud.start(settings.cloudUrl, settings.readerToken);
  await connectHardware();
}

function disconnectAll(): void {
  cloud.stop();
  disconnectHardware();
  activeMoto = null;
  testMode = false;
  pushStatusToWindow();
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle("status:get", () => getAggregateStatus());

  ipcMain.handle("settings:get", () => ({
    cloudUrl: settings.cloudUrl,
    email: settings.email,
    readerId: settings.readerId,
    readerName: settings.readerName,
    hardware: settings.hardware,
    hardwareAddress: settings.hardwareAddress,
    hasSession: !!sessionCookie,
  }));

  ipcMain.handle(
    "auth:login",
    async (_e, input: { cloudUrl: string; email: string; password: string }): Promise<LoginResult> => {
      try {
        const cloudUrl = input.cloudUrl.trim().replace(/\/+$/, "");
        const { cookie, clubId } = await cloudLogin(cloudUrl, input.email.trim(), input.password);
        sessionCookie = cookie;
        settings = { ...settings, cloudUrl, email: input.email.trim(), clubId };
        saveSettings(settings);
        savePassword(input.password);
        saveSessionCookie(cookie);
        const readers = await fetchReaders(cloudUrl, cookie);
        return { ok: true, readers: readers.map((r) => ({ id: r.id, name: r.name, type: r.type, hardwareAddress: r.hardwareAddress ?? null })) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? "Login failed" };
      }
    },
  );

  ipcMain.handle("readers:list", async (): Promise<LoginResult> => {
    try {
      const cookie = await ensureSession();
      const readers = await fetchReaders(settings.cloudUrl, cookie);
      return { ok: true, readers: readers.map((r) => ({ id: r.id, name: r.name, type: r.type, hardwareAddress: r.hardwareAddress ?? null })) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Failed to load readers" };
    }
  });

  ipcMain.handle("connect", async (_e, input: ConnectInput) => {
    try {
      const cookie = await ensureSession();
      const readers = await fetchReaders(settings.cloudUrl, cookie);
      const reader = readers.find((r) => r.id === input.readerId);
      if (!reader) throw new Error("Selected reader no longer exists — refresh the list");

      settings = {
        ...settings,
        readerId: reader.id,
        readerToken: reader.token,
        readerName: reader.name,
        hardware: input.hardware,
        hardwareAddress: input.hardwareAddress.trim(),
      };
      saveSettings(settings);

      await connectAll();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Connection failed" };
    }
  });

  ipcMain.handle("disconnect", () => {
    disconnectAll();
    return { ok: true };
  });

  ipcMain.handle("test:toggle", async (_e, enabled: boolean) => {
    testMode = !!enabled;
    try {
      if (isLlrpHardware()) {
        if (testMode && !llrp.getStatus().reading) {
          await llrp.startReading();
        } else if (!testMode && activeMoto === null && llrp.getStatus().reading) {
          await llrp.stopReading();
        }
      }
      pushStatusToWindow();
      return { ok: true };
    } catch (err: any) {
      testMode = false;
      pushStatusToWindow();
      return { ok: false, error: err?.message ?? "Test mode failed" };
    }
  });

  ipcMain.handle("logout", () => {
    disconnectAll();
    sessionCookie = null;
    clearAll();
    settings = loadSettings();
    return { ok: true };
  });

  ipcMain.handle("open-external", (_e, url: string) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

/** Return a valid session cookie, re-logging in with stored creds if needed. */
async function ensureSession(): Promise<string> {
  if (sessionCookie) {
    try {
      await fetchReaders(settings.cloudUrl, sessionCookie);
      return sessionCookie;
    } catch {
      sessionCookie = null;
    }
  }
  const password = loadPassword();
  if (!settings.cloudUrl || !settings.email || !password) {
    throw new Error("Not signed in — open Settings and sign in");
  }
  const { cookie } = await cloudLogin(settings.cloudUrl, settings.email, password);
  sessionCookie = cookie;
  saveSessionCookie(cookie);
  return cookie;
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

    // Push status to the settings window periodically
    setInterval(() => pushStatusToWindow(), 2_000);

    const configured = !!settings.readerToken && !!settings.hardware && !!settings.hardwareAddress;
    if (configured && settings.autoConnect) {
      connectAll().catch(() => {
        scheduleHardwareReconnect();
        pushStatusToWindow();
      });
    } else {
      openSettingsWindow();
    }
  });

  // Keep running when all windows are closed — we live in the tray
  app.on("window-all-closed", () => {
    /* no-op */
  });

  app.on("before-quit", () => {
    disconnectAll();
  });
}
