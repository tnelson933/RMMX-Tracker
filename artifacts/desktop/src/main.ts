import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  dialog,
} from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import fs from "fs";
import http from "http";
import { ChildProcess, spawn } from "child_process";
import { SyncEngine } from "./sync-engine";
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  getPublicCredentials,
  loadSessionCookie,
  saveSessionCookie,
  clearSessionCookie,
} from "./auth-manager";
import {
  listPorts,
  getSerialStatus,
  connectPort,
  disconnectPort,
} from "./serial";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_PORT = 9090;
const STARTUP_TIMEOUT_MS = 15_000;
const WINDOW_TITLE = "Rocky Mountain Race Platform";

// ── State ─────────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let localServerProcess: ChildProcess | null = null;
let syncEngine: SyncEngine | null = null;

// ── App paths ─────────────────────────────────────────────────────────────────

function getResourcesPath(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.resolve(__dirname, "..", "..");
}

function getLocalServerDist(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "local-server", "dist");
  }
  return path.resolve(__dirname, "../../local-server/dist");
}

function getRacePlatformDist(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "race-platform");
  }
  return path.resolve(__dirname, "../../race-platform/dist");
}

function getDbPath(): string {
  return path.join(app.getPath("userData"), "race_data.db");
}

// ── Local server management ───────────────────────────────────────────────────

function startLocalServer(): Promise<void> {
  const indexMjs = path.join(getLocalServerDist(), "index.mjs");

  if (!fs.existsSync(indexMjs)) {
    const msg = `Local server not found at ${indexMjs}.\nRun "pnpm --filter @workspace/local-server run build" first.`;
    dialog.showErrorBox("Startup Error", msg);
    app.quit();
    return Promise.reject(new Error(msg));
  }

  const staticDir = getRacePlatformDist();
  const dbPath = getDbPath();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(LOCAL_PORT),
    SQLITE_FILE: dbPath,
    SESSION_SECRET: deriveSessionSecret(),
    NODE_ENV: "production",
  };

  if (fs.existsSync(staticDir)) {
    env.STATIC_FILES_DIR = staticDir;
  }

  // Do NOT pass CLOUD_* credentials to the local-server subprocess.
  // The Electron SyncEngine is the sole cloud sync path; injecting those env
  // vars would activate local-server's startAutoSync() and create two competing
  // sync loops hitting different API endpoints (/sync vs /desktop-push).

  // ELECTRON_RUN_AS_NODE=1 is required in packaged builds: process.execPath
  // points to the Electron binary, not a bare Node executable. This flag makes
  // Electron skip its GUI bootstrap and behave exactly like `node <script>`.
  localServerProcess = spawn(process.execPath, [indexMjs], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  localServerProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[local-server] ${data.toString()}`);
  });

  localServerProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[local-server] ${data.toString()}`);
  });

  localServerProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[local-server] exited with code ${code}`);
    }
    localServerProcess = null;
  });

  return waitForLocalServer();
}

function waitForLocalServer(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    function probe() {
      const req = http.get(
        `http://localhost:${LOCAL_PORT}/api/healthz`,
        (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else if (Date.now() < deadline) {
            setTimeout(probe, 300);
          } else {
            reject(new Error("Local server did not start in time"));
          }
        },
      );
      req.on("error", () => {
        if (Date.now() < deadline) {
          setTimeout(probe, 300);
        } else {
          reject(new Error("Local server did not respond in time"));
        }
      });
      req.end();
    }
    probe();
  });
}

function stopLocalServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!localServerProcess) {
      resolve();
      return;
    }
    localServerProcess.once("exit", () => resolve());
    localServerProcess.kill("SIGTERM");
    setTimeout(() => {
      if (localServerProcess) {
        localServerProcess.kill("SIGKILL");
      }
    }, 3000);
  });
}

// ── Session secret (derived from machine-stable data) ─────────────────────────

function deriveSessionSecret(): string {
  const configDir = app.getPath("userData");
  const secretFile = path.join(configDir, ".session-secret");
  if (fs.existsSync(secretFile)) {
    return fs.readFileSync(secretFile, "utf8").trim();
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let secret = "";
  for (let i = 0; i < 48; i++) {
    secret += chars[Math.floor(Math.random() * chars.length)];
  }
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

// ── Sync engine management ────────────────────────────────────────────────────

function startSyncEngine(): void {
  const creds = loadCredentials();
  if (!creds?.cloudUrl || !creds.email || !creds.password) return;

  syncEngine = new SyncEngine({
    dbPath: getDbPath(),
    cloudUrl: creds.cloudUrl,
    clubId: creds.clubId,
    email: creds.email,
    password: creds.password,
    loadCachedCookie:  loadSessionCookie,
    saveCachedCookie:  saveSessionCookie,
    clearCachedCookie: clearSessionCookie,
  });

  syncEngine.onChange((state) => {
    mainWindow?.webContents.send("sync:stateChange", state);
  });

  syncEngine.start();
}

function stopSyncEngine(): void {
  syncEngine?.destroy();
  syncEngine = null;
}

// ── Window creation ───────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: WINDOW_TITLE,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(`http://localhost:${LOCAL_PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  buildMenu();
}

// ── Application menu ──────────────────────────────────────────────────────────

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Cloud Sync Settings…",
          click: () => openSyncSettings(),
        },
        {
          label: "Serial / RFID Settings…",
          click: () => openSerialSettings(),
        },
        { type: "separator" },
        {
          label: "Open Database File",
          click: () => shell.showItemInFolder(getDbPath()),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Force Sync Now",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => void syncEngine?.flush(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
  ];

  if (process.env.NODE_ENV === "development" || !app.isPackaged) {
    (template[2].submenu as Electron.MenuItemConstructorOptions[]).push(
      { type: "separator" },
      { role: "toggleDevTools" },
    );
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openSyncSettings(): void {
  mainWindow?.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('rm-open-sync-settings'))`,
  );
}

function openSerialSettings(): void {
  mainWindow?.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent('rm-open-serial-settings'))`,
  );
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle("sync:getState", () => {
    return (
      syncEngine?.getState() ?? {
        status: "idle" as const,
        pendingCount: 0,
        lastSyncedAt: null,
        lastError: null,
        cloudUrl: null,
        clubId: null,
      }
    );
  });

  ipcMain.handle("sync:flush", async () => {
    await syncEngine?.flush();
  });

  ipcMain.handle("sync:setInterval", (_event, ms: number) => {
    syncEngine?.setInterval(ms);
  });

  ipcMain.handle("serial:listPorts", async () => {
    return listPorts();
  });

  ipcMain.handle("serial:connect", async (_event, portPath: string, baudRate?: number) => {
    await connectPort(portPath, baudRate, (rfidNumber) => {
      postCrossingToLocalServer(rfidNumber);
      mainWindow?.webContents.send("serial:status", getSerialStatus());
    });
    mainWindow?.webContents.send("serial:status", getSerialStatus());
  });

  ipcMain.handle("serial:disconnect", () => {
    disconnectPort();
    mainWindow?.webContents.send("serial:status", getSerialStatus());
  });

  ipcMain.handle("serial:getStatus", () => getSerialStatus());

  ipcMain.handle("auth:getCredentials", () => getPublicCredentials());

  ipcMain.handle(
    "auth:setCredentials",
    (_event, email: string, password: string, cloudUrl: string, clubId: string) => {
      saveCredentials({ email, password, cloudUrl, clubId });
      stopSyncEngine();
      startSyncEngine();
    },
  );

  ipcMain.handle("auth:clearCredentials", () => {
    clearCredentials();
    stopSyncEngine();
  });

  ipcMain.handle("app:getVersion", () => app.getVersion());
}

// ── Forward RFID tag reads from serial port to local server ───────────────────

function postCrossingToLocalServer(rfidNumber: string): void {
  const body = JSON.stringify({ rfidNumber, crossingTime: new Date().toISOString() });
  const req = http.request(
    {
      host: "localhost",
      port: LOCAL_PORT,
      path: "/api/timing/active/crossing",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        console.error(`[rfid] crossing rejected: HTTP ${res.statusCode}`);
      }
      res.resume();

      if (syncEngine) {
        setTimeout(() => void syncEngine?.flush(), 800);
      }
    },
  );

  req.on("error", (err) => {
    console.error(`[rfid] failed to post crossing: ${err.message}`);
  });

  req.write(body);
  req.end();
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    dialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: `Rocky Mountain Race v${info.version} is available and will be installed automatically when you quit.`,
      buttons: ["OK"],
    });
  });

  autoUpdater.on("update-downloaded", () => {
    dialog
      .showMessageBox({
        type: "info",
        title: "Restart to update",
        message:
          "A new version has been downloaded. Restart the app now to apply the update.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] auto-update error:", err.message);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
    console.error("[updater] checkForUpdatesAndNotify failed:", err.message);
  });
}

// ── Electron app lifecycle ────────────────────────────────────────────────────

app.whenReady().then(async () => {
  registerIpcHandlers();

  try {
    await startLocalServer();
    console.log(`[main] Local server ready on :${LOCAL_PORT}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("Failed to start local server", msg);
    app.quit();
    return;
  }

  createWindow();
  startSyncEngine();
  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    cleanupAndQuit();
  }
});

app.on("before-quit", () => {
  cleanupAndQuit();
});

function cleanupAndQuit(): void {
  stopSyncEngine();
  disconnectPort();
  void stopLocalServer().finally(() => {
    app.quit();
  });
}
