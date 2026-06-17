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
import {
  connectDecoder,
  disconnectDecoder,
  getMyLapsStatus,
} from "./mylaps";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOCAL_PORT = 9090;
const STARTUP_TIMEOUT_MS = 15_000;
const WINDOW_TITLE = "RM Tracker";

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
  return path.resolve(__dirname, "../../race-platform/dist/public");
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

  // Pass CLOUD_URL (but NOT auth credentials) to the local server so it can
  // redirect /register/:id requests to the cloud registration page.
  // CLOUD_URL alone does not activate startAutoSync() — that requires CLUB_ID
  // plus auth credentials too.
  const savedCreds = loadCredentials();
  if (savedCreds?.cloudUrl) {
    env.CLOUD_URL = savedCreds.cloudUrl;
  }

  // Do NOT pass CLOUD_EMAIL / CLOUD_PASSWORD / CLUB_ID / SYNC_TOKEN to the
  // local-server subprocess — those would activate local-server's startAutoSync()
  // and create two competing sync loops hitting different API endpoints.

  // ELECTRON_RUN_AS_NODE=1 is required in packaged builds: process.execPath
  // points to the Electron binary, not a bare Node executable. This flag makes
  // Electron skip its GUI bootstrap and behave exactly like `node <script>`.
  localServerProcess = spawn(process.execPath, [indexMjs], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Collect stderr so we can show the real crash reason in the error dialog.
  const stderrLines: string[] = [];

  localServerProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[local-server] ${data.toString()}`);
  });

  localServerProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    process.stderr.write(`[local-server] ${text}`);
    stderrLines.push(...text.split("\n").filter(Boolean));
    if (stderrLines.length > 40) stderrLines.splice(0, stderrLines.length - 40);
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    function fail(err: Error) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
    function succeed() {
      if (!settled) {
        settled = true;
        resolve();
      }
    }

    // Fail fast if the process exits before the healthcheck passes.
    localServerProcess!.on("exit", (code) => {
      localServerProcess = null;
      if (!settled) {
        const detail = stderrLines.slice(-20).join("\n") || "(no output)";
        fail(
          new Error(
            `Local server exited with code ${code ?? "null"}.\n\nOutput:\n${detail}`,
          ),
        );
      }
    });

    // Poll the healthcheck endpoint until the server is up.
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    function probe() {
      if (settled) return;
      const req = http.get(
        `http://127.0.0.1:${LOCAL_PORT}/api/healthz`,
        (res) => {
          if (res.statusCode === 200) {
            succeed();
          } else if (Date.now() < deadline) {
            setTimeout(probe, 300);
          } else {
            const detail = stderrLines.slice(-20).join("\n") || "(no output)";
            fail(
              new Error(
                `Local server did not start in time.\n\nOutput:\n${detail}`,
              ),
            );
          }
        },
      );
      req.on("error", () => {
        if (settled) return;
        if (Date.now() < deadline) {
          setTimeout(probe, 300);
        } else {
          const detail = stderrLines.slice(-20).join("\n") || "(no output)";
          fail(
            new Error(
              `Local server did not respond in time.\n\nOutput:\n${detail}`,
            ),
          );
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
    minHeight: 800,
    title: WINDOW_TITLE,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${LOCAL_PORT}/login`);

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
      postCrossingToLocalServer({ tag: rfidNumber });
      mainWindow?.webContents.send("serial:status", getSerialStatus());
    });
    mainWindow?.webContents.send("serial:status", getSerialStatus());
  });

  ipcMain.handle("serial:disconnect", () => {
    disconnectPort();
    mainWindow?.webContents.send("serial:status", getSerialStatus());
  });

  ipcMain.handle("serial:getStatus", () => getSerialStatus());

  ipcMain.handle("mylaps:connect", async (_event, ip: string) => {
    await connectDecoder(ip, (transponder, crossingTime) => {
      postCrossingToLocalServer({ tag: transponder, fieldName: "transponder", crossingTime });
      mainWindow?.webContents.send("mylaps:status", getMyLapsStatus());
    });
    mainWindow?.webContents.send("mylaps:status", getMyLapsStatus());
  });

  ipcMain.handle("mylaps:disconnect", () => {
    disconnectDecoder();
    mainWindow?.webContents.send("mylaps:status", getMyLapsStatus());
  });

  ipcMain.handle("mylaps:getStatus", () => getMyLapsStatus());

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

  ipcMain.handle(
    "auth:cloudLogin",
    async (_event, email: string, password: string, fallbackCloudUrl: string) => {
      const saved = loadCredentials();
      const cloudUrl = (saved?.cloudUrl || fallbackCloudUrl || "").replace(/\/$/, "");
      if (!cloudUrl) {
        return {
          ok: false,
          error:
            "Cloud URL not configured. Open Cloud Sync Settings from the app menu and enter your cloud URL.",
        };
      }

      try {
        const loginRes = await fetch(`${cloudUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (!loginRes.ok) {
          const body = await loginRes.text().catch(() => "");
          return { ok: false, error: `Cloud login failed (${loginRes.status}): ${body}` };
        }

        const data = (await loginRes.json()) as { user?: { clubId?: number } };
        const clubId = data?.user?.clubId;
        if (!clubId) {
          return { ok: false, error: "Cloud login succeeded but no club ID was returned." };
        }

        saveCredentials({ email, password, cloudUrl, clubId: String(clubId) });
        stopSyncEngine();
        startSyncEngine();

        if (syncEngine) {
          await syncEngine.flush();
          // Surface any sync error so the UI can warn the user that data may be
          // incomplete, without blocking the login flow.
          const syncState = syncEngine.getState();
          if (syncState.status === "error" && syncState.lastError) {
            return { ok: true, syncWarning: syncState.lastError };
          }
        }

        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "ai:suggestPointsTable",
    async (
      _event,
      body: { scoringDescription: string; motoDescription?: string },
    ) => {
      if (!syncEngine) {
        return {
          ok: false,
          status: 503,
          data: {
            error:
              "Cloud sync not configured. Please open Cloud Sync Settings and connect to your server first.",
          },
        };
      }
      try {
        return await syncEngine.cloudFetch("/api/ai/suggest-points-table", {
          method: "POST",
          body,
        });
      } catch (err) {
        return {
          ok: false,
          status: 500,
          data: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  );

  ipcMain.handle(
    "ai:tweakPointsTable",
    async (_event, body: { instruction: string; currentTable: unknown }) => {
      if (!syncEngine) {
        return {
          ok: false,
          status: 503,
          data: { error: "Cloud sync not configured." },
        };
      }
      try {
        return await syncEngine.cloudFetch("/api/ai/tweak-points-table", {
          method: "POST",
          body,
        });
      } catch (err) {
        return {
          ok: false,
          status: 500,
          data: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  );

  ipcMain.handle("app:getVersion", () => app.getVersion());

  // ── AI Assistant conversation handlers (AIAssistant component) ───────────────
  // These route through the sync engine's authenticated cloudFetch so that the
  // floating AI Assistant panel works on desktop exactly as it does on the web.

  ipcMain.handle("ai:listConversations", async () => {
    if (!syncEngine) return { ok: false, status: 503, data: [] };
    try {
      return await syncEngine.cloudFetch("/api/anthropic/conversations");
    } catch (err) {
      return { ok: false, status: 500, data: [] };
    }
  });

  ipcMain.handle("ai:createConversation", async (_event, title: string) => {
    if (!syncEngine) return { ok: false, status: 503, data: null };
    try {
      return await syncEngine.cloudFetch("/api/anthropic/conversations", {
        method: "POST",
        body: { title },
      });
    } catch (err) {
      return { ok: false, status: 500, data: null };
    }
  });

  ipcMain.handle("ai:getConversation", async (_event, id: number) => {
    if (!syncEngine) return { ok: false, status: 503, data: null };
    try {
      return await syncEngine.cloudFetch(`/api/anthropic/conversations/${id}`);
    } catch (err) {
      return { ok: false, status: 500, data: null };
    }
  });

  ipcMain.handle("ai:deleteConversation", async (_event, id: number) => {
    if (!syncEngine) return { ok: false, status: 503, data: null };
    try {
      return await syncEngine.cloudFetch(`/api/anthropic/conversations/${id}`, {
        method: "DELETE",
      });
    } catch (err) {
      return { ok: false, status: 500, data: null };
    }
  });

  // ai:sendMessage collects the full SSE stream from the cloud streaming endpoint
  // and returns the assembled text in one shot — no token-by-token streaming on desktop.
  ipcMain.handle("ai:sendMessage", async (_event, convId: number, content: string) => {
    if (!syncEngine) {
      return { ok: false, error: "Cloud sync not configured. Please connect via Cloud Sync Settings." };
    }
    try {
      const result = await syncEngine.cloudFetch(
        `/api/anthropic/conversations/${convId}/messages`,
        { method: "POST", body: { content } },
      );
      if (!result.ok) {
        const errData = result.data as any;
        return { ok: false, error: errData?.error ?? `Server error (${result.status})` };
      }
      // The cloud endpoint streams SSE; cloudFetch buffers it all into a string.
      const sseText = typeof result.data === "string" ? result.data : "";
      let full = "";
      for (const line of sseText.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6)) as {
            content?: string;
            done?: boolean;
            error?: string;
          };
          if (payload.content) full += payload.content;
          else if (payload.error) return { ok: false, error: payload.error };
        } catch { /* skip malformed SSE lines */ }
      }
      return { ok: true, text: full };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ── Forward tag reads to local server ─────────────────────────────────────────

function postCrossingToLocalServer(opts: {
  tag: string;
  fieldName?: "rfidNumber" | "transponder";
  crossingTime?: Date;
}): void {
  const { tag, fieldName = "rfidNumber", crossingTime } = opts;
  const body = JSON.stringify({ [fieldName]: tag, crossingTime: (crossingTime ?? new Date()).toISOString() });
  const req = http.request(
    {
      host: "127.0.0.1",
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
      message: `RM Tracker v${info.version} is available and will be installed automatically when you quit.`,
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
  disconnectDecoder();
  void stopLocalServer().finally(() => {
    app.quit();
  });
}
