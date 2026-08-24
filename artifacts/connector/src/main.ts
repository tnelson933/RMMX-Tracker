/**
 * RM Connect — main process.
 *
 * A tray-only Electron app that bridges local timing hardware to the cloud:
 *   - Impinj R700 via LLRP (TCP 5084, reached by mDNS hostname from MAC digits)
 *   - Feibot F2000 active transponder timing (TCP 3333)
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
import { FeibotClient } from "./feibot";
import { RecentReadDeduper } from "./recent-read-deduper";
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
const feibot = new FeibotClient();
const cloud = new CloudLink();

let activeMoto: { motoId: number; name: string } | null = null;
let testMode = false;
let deviceReconnectTimer: NodeJS.Timeout | null = null;
let hardwareWanted = false; // true while the user wants the device connected
let hardwareConnecting = false;
let reconnectNextAttemptAt: string | null = null;
let testProgress: AggregateStatus["testProgress"] = "inactive";
let testMessage: string | null = null;

const LOCAL_DEDUPE_MS = 1_500;
const recentReads = new RecentReadDeduper(LOCAL_DEDUPE_MS);

// ── Status aggregation ────────────────────────────────────────────────────────

function getAggregateStatus(): AggregateStatus {
  const isLlrp = settings.hardware === "impinj" || settings.hardware === "zebra" || settings.hardware === "generic";
  const dev = isLlrp ? llrp.getStatus() : null;
  const active = settings.hardware === "active_transponder" ? feibot.getStatus() : null;

  const cloudStatus = cloud.getStatus();
  const deviceConnected = dev?.connected ?? active?.connected ?? false;
  const deviceError = dev?.error ?? active?.error ?? null;
  const state: AggregateStatus["state"] = deviceError ? "error"
    : reconnectNextAttemptAt ? "reconnecting"
      : hardwareConnecting ? "connecting"
        : activeMoto ? "race_active"
          : testMode ? "testing"
            : deviceConnected ? "connected_idle" : "disconnected";
  const diagnosis = active?.diagnosis
    ?? deviceError
    ?? (!cloudStatus.connected ? (cloudStatus.error ?? "Cloud disconnected — check internet access and reader registration.") : null)
    ?? (!activeMoto && !testMode ? "No active moto. Start a moto in RM Race when you are ready to time." : null);
  return {
    configured: !!settings.readerToken && !!settings.hardware && !!settings.hardwareAddress,
    cloudUrl: settings.cloudUrl,
    email: settings.email,
    readerName: settings.readerName,
    hardware: settings.hardware,
    hardwareAddress: settings.hardwareAddress,
    cloud: {
      connected: cloudStatus.connected,
      error: cloudStatus.error,
    },
    state,
    reconnect: {
      nextAttemptAt: reconnectNextAttemptAt,
      secondsUntilAttempt: reconnectNextAttemptAt ? Math.max(0, Math.ceil((new Date(reconnectNextAttemptAt).getTime() - Date.now()) / 1000)) : null,
    },
    device: {
      connected: deviceConnected,
      reading: dev?.reading ?? active?.reading ?? false,
      error: deviceError,
      detail: active?.detail ?? null,
      lastReadAt: dev?.lastReadAt ?? active?.lastPassingAt ?? null,
      readCount: dev?.readCount ?? active?.passingCount ?? 0,
      antennaIds: dev?.antennaIds ?? [],
      transportReady: active?.transportReady,
      heartbeatFresh: active?.heartbeatFresh,
      machineId: active?.machineId,
      loop1State: active?.loop1State,
      loop2State: active?.loop2State,
      diagnosis,
      ready: active?.ready,
    },
    activeMoto,
    testMode,
    testProgress,
    testMessage,
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

  if (!recentReads.accept(rfidNumber)) return;

  try {
    if (testMode) {
      testProgress = "sending_crossing";
      testMessage = "PowerTag received. Sending the crossing to RM Race…";
      pushStatusToWindow();
    }
    const result = await cloud.postCrossing({ rfidNumber, crossingTime, antennaId, clubId: settings.clubId });
    if (testMode) {
      if (result.ok) {
        testProgress = "confirmed";
        testMessage = result.message ?? "PowerTag crossing received and confirmed by RM Race.";
        testMode = false;
        if (!activeMoto) {
          if (isLlrpHardware()) await llrp.stopReading().catch(() => {});
          else feibot.stopReading();
        }
      } else {
        testProgress = "unresolved";
        testMessage = result.message ?? "PowerTag was read, but RM Race could not confirm the crossing. Check cloud connection and reader registration.";
      }
      pushStatusToWindow();
    }
  } catch {
    if (testMode) {
      testProgress = "unresolved";
      testMessage = "PowerTag was read, but the crossing could not reach RM Race. Check the cloud connection.";
      pushStatusToWindow();
    }
    // Network hiccup — the rider will cross again next lap; server-side
    // parity/debounce keeps state consistent. Cloud WS status shows red.
  }
}

llrp.on("tag", (read) => {
  forwardCrossing(read.epcHex, new Date(), read.antennaId).catch(() => {});
  pushStatusToWindow();
});

feibot.on("tag", (tag: string, crossingTime: Date) => {
  if (testMode) {
    testProgress = "sending_crossing";
    testMessage = "PowerTag received from Feibot. Confirming the cloud crossing…";
  }
  forwardCrossing(tag, crossingTime).catch(() => {});
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
  return addr; // zebra/generic: hostname or IP · Feibot: hostname/IP[:port]
}

function applyFeibotSettings(): void {
  feibot.configure({
    channel: settings.feibotChannel,
    power: settings.feibotPower,
    loop1Enabled: settings.feibotLoop1Enabled,
    loop2Enabled: settings.feibotLoop2Enabled,
  });
}

function applyWebsiteActiveTimingConfig(
  config: { channel: number; power: number; loop1Enabled: boolean; loop2Enabled: boolean },
  syncClock = false,
): void {
  if (!Number.isInteger(config.channel) || config.channel < 0 || config.channel > 5) {
    throw new Error("Website sent an invalid Feibot channel.");
  }
  if (!Number.isInteger(config.power) || config.power < 0 || config.power > 100) {
    throw new Error("Website sent an invalid Feibot power value.");
  }
  settings = {
    ...settings,
    feibotChannel: config.channel,
    feibotPower: config.power,
    feibotLoop1Enabled: !!config.loop1Enabled,
    feibotLoop2Enabled: !!config.loop2Enabled,
  };
  saveSettings(settings);
  applyFeibotSettings();
  if (syncClock && feibot.getStatus().transportReady) feibot.syncClock();
}

async function connectHardware(): Promise<void> {
  hardwareWanted = true;
  hardwareConnecting = true;
  reconnectNextAttemptAt = null;
  const host = resolveHardwareHost();
  try {
    if (isLlrpHardware()) {
      await llrp.connect(host, { impinjExtensions: settings.hardware === "impinj" });
      // If a moto is already live (reconnect mid-race), resume reading
      if (shouldForward()) {
        await llrp.startReading().catch(() => {});
      }
    } else if (settings.hardware === "active_transponder") {
      applyFeibotSettings();
      await feibot.connect(host);
      if (shouldForward()) feibot.startReading();
    }
  } finally {
    hardwareConnecting = false;
  }
  pushStatusToWindow();
}

function disconnectHardware(): void {
  hardwareWanted = false;
  hardwareConnecting = false;
  reconnectNextAttemptAt = null;
  if (deviceReconnectTimer) {
    clearTimeout(deviceReconnectTimer);
    deviceReconnectTimer = null;
  }
  llrp.disconnect().catch(() => {});
  feibot.disconnect();
  pushStatusToWindow();
}

function scheduleHardwareReconnect(): void {
  if (!hardwareWanted || deviceReconnectTimer) return;
  reconnectNextAttemptAt = new Date(Date.now() + 10_000).toISOString();
  deviceReconnectTimer = setTimeout(() => {
    deviceReconnectTimer = null;
    reconnectNextAttemptAt = null;
    if (!hardwareWanted) return;
    connectHardware().catch(() => scheduleHardwareReconnect());
  }, 10_000);
}

llrp.on("disconnected", () => {
  scheduleHardwareReconnect();
  pushStatusToWindow();
});
llrp.on("error", () => pushStatusToWindow());
feibot.on("disconnected", () => {
  scheduleHardwareReconnect();
  pushStatusToWindow();
});
feibot.on("status", () => {
  if (testMode && testProgress === "opening_loops" && feibot.getStatus().transportReady) {
    testProgress = "waiting_for_tag";
    testMessage = "Feibot is identified. Both loops were asked to open; pass a PowerTag over either loop.";
  }
  pushStatusToWindow();
});
feibot.on("error", pushStatusToWindow);

// ── Cloud command handling ────────────────────────────────────────────────────

cloud.setStatusProvider(() => {
  const s = getAggregateStatus();
  return {
    hardware: settings.hardware,
    connected: s.device.connected,
    detail: s.device.error ?? s.device.detail ?? null,
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
    } else if (settings.hardware === "active_transponder") {
      applyFeibotSettings();
      feibot.startReading();
    }
  } else if (cmd.type === "stop_moto") {
    activeMoto = null;
    if (isLlrpHardware() && !testMode) {
      llrp.stopReading().catch(() => {});
    } else if (settings.hardware === "active_transponder" && !testMode) {
      feibot.stopReading();
    }
  } else if (cmd.type === "set_llrp_config" && cmd.config && isLlrpHardware()) {
    llrp.applyRfConfig(cmd.config as { transmitPowerIndex: number; rfModeIndex: number; tagPopulation: number; tagTransitTime: number }).catch(() => {
      // Non-fatal — config stored and will be applied on next reconnect
    });
  } else if (cmd.type === "set_active_timing_config" && cmd.config && settings.hardware === "active_transponder") {
    try {
      applyWebsiteActiveTimingConfig(cmd.config as { channel: number; power: number; loop1Enabled: boolean; loop2Enabled: boolean }, cmd.syncClock === true);
    } catch {
      // Preserve the active connection and report its existing status; a valid
      // portal save is replayed automatically on the next connector reconnect.
    }
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
    feibotChannel: settings.feibotChannel,
    feibotPower: settings.feibotPower,
    feibotLoop1Enabled: settings.feibotLoop1Enabled,
    feibotLoop2Enabled: settings.feibotLoop2Enabled,
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
        return { ok: true, readers: readers.map((r) => ({ id: r.id, name: r.name, type: r.type, hardwareAddress: r.hardwareAddress ?? null, activeTimingConfig: r.activeTimingConfig ?? null })) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? "Login failed" };
      }
    },
  );

  ipcMain.handle("readers:list", async (): Promise<LoginResult> => {
    try {
      const cookie = await ensureSession();
      const readers = await fetchReaders(settings.cloudUrl, cookie);
      return { ok: true, readers: readers.map((r) => ({ id: r.id, name: r.name, type: r.type, hardwareAddress: r.hardwareAddress ?? null, activeTimingConfig: r.activeTimingConfig ?? null })) };
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
        // The cloud registration is canonical when it has an address. Keep a
        // single saved address locally rather than maintaining a second value.
        hardwareAddress: reader.hardwareAddress?.trim() || input.hardwareAddress.trim(),
      };
      if (reader.type === "active_transponder" && reader.activeTimingConfig) {
        settings = {
          ...settings,
          feibotChannel: reader.activeTimingConfig.channel,
          feibotPower: reader.activeTimingConfig.power,
          feibotLoop1Enabled: reader.activeTimingConfig.loop1Enabled,
          feibotLoop2Enabled: reader.activeTimingConfig.loop2Enabled,
        };
      }
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

  ipcMain.handle("hardware:configure", async (_e, input: { channel: number; power: number; loop1Enabled: boolean; loop2Enabled: boolean; syncClock?: boolean }) => {
    try {
      if (settings.hardware !== "active_transponder") throw new Error("Feibot settings are only available for an F2000 reader.");
      if (!Number.isInteger(input.channel) || input.channel < 0 || input.channel > 5) throw new Error("Channel must be a whole number from 0 to 5.");
      if (!Number.isInteger(input.power) || input.power < 0 || input.power > 100) throw new Error("Power must be a whole number from 0 to 100.");
      settings = { ...settings, feibotChannel: input.channel, feibotPower: input.power, feibotLoop1Enabled: !!input.loop1Enabled, feibotLoop2Enabled: !!input.loop2Enabled };
      saveSettings(settings);
      applyFeibotSettings();
      if (input.syncClock) feibot.syncClock();
      pushStatusToWindow();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "Unable to apply Feibot settings." };
    }
  });

  ipcMain.handle("test:toggle", async (_e, enabled: boolean) => {
    testMode = !!enabled;
    testProgress = testMode ? (settings.hardware === "active_transponder" ? "opening_loops" : "waiting_for_tag") : "inactive";
    testMessage = testMode ? (settings.hardware === "active_transponder"
      ? "Opening Feibot loops 1 and 2. Waiting for a real PowerTag crossing…"
      : "Waiting for a real tag read…") : null;
    try {
      if (isLlrpHardware()) {
        if (testMode && !llrp.getStatus().reading) {
          await llrp.startReading();
        } else if (!testMode && activeMoto === null && llrp.getStatus().reading) {
          await llrp.stopReading();
        }
      } else if (settings.hardware === "active_transponder") {
        if (testMode || activeMoto !== null) feibot.startReading();
        else feibot.stopReading();
        if (testMode && feibot.getStatus().transportReady) {
          testProgress = "waiting_for_tag";
          testMessage = "Both Feibot loops were asked to open. Pass a PowerTag over either loop.";
        }
      }
      pushStatusToWindow();
      return { ok: true };
    } catch (err: any) {
      testMode = false;
      testProgress = "unresolved";
      testMessage = err?.message ?? "Unable to start the hardware test.";
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
