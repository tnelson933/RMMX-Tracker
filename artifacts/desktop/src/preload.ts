import { contextBridge, ipcRenderer } from "electron";
import type {
  SyncState,
  SerialPortInfo,
  SerialStatus,
  MyLapsStatus,
  CloudCredentials,
} from "./ipc-types";

const electronAPI = {
  sync: {
    getState: (): Promise<SyncState> => ipcRenderer.invoke("sync:getState"),
    flush: (): Promise<void> => ipcRenderer.invoke("sync:flush"),
    setInterval: (ms: number): Promise<void> =>
      ipcRenderer.invoke("sync:setInterval", ms),
    onChange: (cb: (state: SyncState) => void): (() => void) => {
      const handler = (_: unknown, state: SyncState) => cb(state);
      ipcRenderer.on("sync:stateChange", handler);
      return () => ipcRenderer.off("sync:stateChange", handler);
    },
  },

  serial: {
    listPorts: (): Promise<SerialPortInfo[]> =>
      ipcRenderer.invoke("serial:listPorts"),
    connect: (portPath: string, baudRate?: number): Promise<void> =>
      ipcRenderer.invoke("serial:connect", portPath, baudRate),
    disconnect: (): Promise<void> => ipcRenderer.invoke("serial:disconnect"),
    getStatus: (): Promise<SerialStatus> =>
      ipcRenderer.invoke("serial:getStatus"),
    onStatus: (cb: (status: SerialStatus) => void): (() => void) => {
      const handler = (_: unknown, status: SerialStatus) => cb(status);
      ipcRenderer.on("serial:status", handler);
      return () => ipcRenderer.off("serial:status", handler);
    },
  },

  mylaps: {
    connect: (ip: string): Promise<void> => ipcRenderer.invoke("mylaps:connect", ip),
    disconnect: (): Promise<void> => ipcRenderer.invoke("mylaps:disconnect"),
    getStatus: (): Promise<MyLapsStatus> => ipcRenderer.invoke("mylaps:getStatus"),
    onStatus: (cb: (status: MyLapsStatus) => void): (() => void) => {
      const handler = (_: unknown, status: MyLapsStatus) => cb(status);
      ipcRenderer.on("mylaps:status", handler);
      return () => ipcRenderer.off("mylaps:status", handler);
    },
  },

  auth: {
    getCredentials: (): Promise<CloudCredentials | null> =>
      ipcRenderer.invoke("auth:getCredentials"),
    setCredentials: (
      email: string,
      password: string,
      cloudUrl: string,
      clubId: string,
    ): Promise<void> =>
      ipcRenderer.invoke("auth:setCredentials", email, password, cloudUrl, clubId),
    clearCredentials: (): Promise<void> =>
      ipcRenderer.invoke("auth:clearCredentials"),
    cloudLogin: (
      email: string,
      password: string,
      fallbackCloudUrl: string,
    ): Promise<{ ok: boolean; error?: string; syncWarning?: string }> =>
      ipcRenderer.invoke("auth:cloudLogin", email, password, fallbackCloudUrl),
  },

  ai: {
    suggestPointsTable: (body: {
      scoringDescription: string;
      motoDescription?: string;
    }): Promise<{ ok: boolean; status: number; data: unknown }> =>
      ipcRenderer.invoke("ai:suggestPointsTable", body),
    tweakPointsTable: (body: {
      instruction: string;
      currentTable: unknown;
    }): Promise<{ ok: boolean; status: number; data: unknown }> =>
      ipcRenderer.invoke("ai:tweakPointsTable", body),
    listConversations: (): Promise<{ ok: boolean; status: number; data: unknown }> =>
      ipcRenderer.invoke("ai:listConversations"),
    createConversation: (title: string): Promise<{ ok: boolean; status: number; data: unknown }> =>
      ipcRenderer.invoke("ai:createConversation", title),
    getConversation: (id: number): Promise<{ ok: boolean; status: number; data: unknown }> =>
      ipcRenderer.invoke("ai:getConversation", id),
    deleteConversation: (id: number): Promise<{ ok: boolean; status: number; data: unknown }> =>
      ipcRenderer.invoke("ai:deleteConversation", id),
    sendMessage: (convId: number, content: string): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke("ai:sendMessage", convId, content),
  },

  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
    platform: process.platform,
  },

  // Synchronously resolved at page load — used by publicOrigin.ts so that
  // widget embed URLs point to the cloud even when VITE_CLOUD_URL wasn't
  // baked into the build at CI time.
  cloudUrl: ipcRenderer.sendSync("auth:getCloudUrlSync") as string,
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

window.addEventListener("DOMContentLoaded", () => {
  injectSyncBar();
});

// ── Sync status bar (top-right corner) ───────────────────────────────────────

function injectSyncBar(): void {
  const style = document.createElement("style");
  style.textContent = `
    #rm-sync-bar {
      position: fixed;
      top: 0;
      right: 0;
      z-index: 99999;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-family: system-ui, sans-serif;
      font-size: 11px;
      font-weight: 500;
      background: rgba(0,0,0,0.72);
      color: #fff;
      border-bottom-left-radius: 6px;
      user-select: none;
      pointer-events: none;
      backdrop-filter: blur(4px);
      transition: opacity 0.2s;
      max-width: 480px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #rm-sync-bar.error {
      pointer-events: auto;
      cursor: pointer;
    }
    #rm-sync-bar .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    #rm-sync-bar.idle .dot    { background: #22c55e; }
    #rm-sync-bar.syncing .dot { background: #f59e0b; animation: rm-blink 0.8s steps(1) infinite; }
    #rm-sync-bar.offline .dot { background: #ef4444; }
    #rm-sync-bar.error .dot   { background: #ef4444; }
    #rm-sync-bar.no-cloud     { display: none; }
    @keyframes rm-blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
  `;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "rm-sync-bar";
  bar.className = "no-cloud";
  bar.innerHTML = `<span class="dot"></span><span id="rm-sync-label">Synced</span>`;
  document.body.appendChild(bar);

  function updateBar(state: SyncState): void {
    if (!state.cloudUrl) {
      bar.className = "no-cloud";
      return;
    }

    const label = document.getElementById("rm-sync-label");
    if (!label) return;

    bar.className = state.status;
    switch (state.status) {
      case "idle": {
        const ts = state.lastSyncedAt
          ? new Date(state.lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : null;
        label.textContent = ts ? `Synced ${ts}` : "Synced";
        break;
      }
      case "syncing":
        label.textContent = `Syncing${state.pendingCount > 0 ? ` (${state.pendingCount})` : ""}…`;
        break;
      case "offline":
        label.textContent = `Offline — ${state.pendingCount} pending`;
        break;
      case "error": {
        const snippet = state.lastError
          ? state.lastError.replace(/\n/g, " ").slice(0, 100)
          : "unknown error";
        label.textContent = `Sync error: ${snippet}`;
        bar.title = state.lastError ?? "Unknown sync error";
        bar.onclick = () => {
          if (state.lastError) alert(`Cloud Sync Error:\n\n${state.lastError}`);
        };
        break;
      }
    }
  }

  electronAPI.sync.getState().then(updateBar).catch(() => {});
  electronAPI.sync.onChange(updateBar);
}
