import { contextBridge, ipcRenderer } from "electron";
import type {
  SyncState,
  SerialPortInfo,
  SerialStatus,
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
  },

  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
    platform: process.platform,
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

window.addEventListener("DOMContentLoaded", () => {
  injectSyncBar();
  injectSyncModal();
  injectSerialModal();
  autoShowLoginIfNeeded();
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
      case "error":
        label.textContent = `Sync error — ${state.pendingCount} pending`;
        break;
    }
  }

  electronAPI.sync.getState().then(updateBar).catch(() => {});
  electronAPI.sync.onChange(updateBar);
}

// ── Cloud sync settings / first-launch login modal ───────────────────────────

function injectSyncModal(): void {
  const style = document.createElement("style");
  style.textContent = `
    #rm-modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 999999;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(3px);
      align-items: center;
      justify-content: center;
    }
    #rm-modal-backdrop.open { display: flex; }
    #rm-modal {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 28px 32px;
      width: 420px;
      max-width: 94vw;
      color: #f1f5f9;
      font-family: system-ui, sans-serif;
      box-shadow: 0 25px 60px rgba(0,0,0,0.5);
    }
    #rm-modal h2 {
      margin: 0 0 6px;
      font-size: 17px;
      font-weight: 700;
      color: #f8fafc;
    }
    #rm-modal p.rm-subtitle {
      margin: 0 0 22px;
      font-size: 13px;
      color: #94a3b8;
      line-height: 1.5;
    }
    #rm-modal label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 5px;
    }
    #rm-modal input {
      width: 100%;
      box-sizing: border-box;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 9px 11px;
      font-size: 14px;
      color: #f1f5f9;
      margin-bottom: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    #rm-modal input:focus { border-color: #6366f1; }
    #rm-modal .rm-row { display: flex; gap: 10px; }
    #rm-modal .rm-row > div { flex: 1; }
    .rm-btn {
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s;
    }
    .rm-btn:hover { opacity: 0.88; }
    .rm-btn-primary { background: #6366f1; color: #fff; }
    .rm-btn-ghost   { background: transparent; color: #94a3b8; border: 1px solid #334155; }
    #rm-modal .rm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 6px;
    }
    #rm-modal .rm-msg {
      font-size: 13px;
      margin-bottom: 14px;
      border-radius: 6px;
      padding: 8px 12px;
    }
    #rm-modal .rm-msg.error   { background: #450a0a; color: #fca5a5; }
    #rm-modal .rm-msg.success { background: #052e16; color: #86efac; }
    #rm-modal .rm-msg.hidden  { display: none; }
    #rm-modal .rm-clear-btn {
      font-size: 12px;
      color: #ef4444;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0;
      margin-left: auto;
      display: block;
      margin-bottom: 18px;
    }
    #rm-modal .rm-clear-btn:hover { text-decoration: underline; }
    .rm-btn-test { background: #0f172a; color: #a5b4fc; border: 1px solid #4f46e5; }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement("div");
  backdrop.id = "rm-modal-backdrop";
  backdrop.innerHTML = `
    <div id="rm-modal">
      <h2>Cloud Sync Settings</h2>
      <p class="rm-subtitle">Connect this desktop app to your Rocky Mountain Race Platform cloud account to sync registrations, check-ins, and timing data in real time.</p>
      <div id="rm-modal-msg" class="rm-msg hidden"></div>
      <label>Cloud URL</label>
      <input id="rm-field-url" type="url" placeholder="https://your-app.replit.app" autocomplete="off" />
      <div class="rm-row">
        <div>
          <label>Club ID</label>
          <input id="rm-field-clubid" type="text" placeholder="1" autocomplete="off" />
        </div>
        <div>
          <label>Email</label>
          <input id="rm-field-email" type="email" placeholder="you@club.com" autocomplete="email" />
        </div>
      </div>
      <label>Password</label>
      <input id="rm-field-password" type="password" autocomplete="current-password" />
      <div class="rm-actions">
        <button class="rm-btn rm-btn-ghost" id="rm-modal-cancel">Cancel</button>
        <button class="rm-btn rm-btn-test" id="rm-modal-test">Test Connection</button>
        <button class="rm-btn rm-btn-primary" id="rm-modal-save">Save &amp; Connect</button>
      </div>
      <button class="rm-clear-btn" id="rm-modal-clear">Disconnect cloud sync</button>
    </div>
  `;
  document.body.appendChild(backdrop);

  function showMsg(text: string, kind: "error" | "success"): void {
    const el = document.getElementById("rm-modal-msg");
    if (!el) return;
    el.textContent = text;
    el.className = `rm-msg ${kind}`;
  }
  function hideMsg(): void {
    const el = document.getElementById("rm-modal-msg");
    if (el) el.className = "rm-msg hidden";
  }

  function openModal(): void {
    hideMsg();
    electronAPI.auth.getCredentials().then((creds) => {
      (document.getElementById("rm-field-url") as HTMLInputElement).value     = creds?.cloudUrl  ?? "";
      (document.getElementById("rm-field-clubid") as HTMLInputElement).value  = creds?.clubId    ?? "";
      (document.getElementById("rm-field-email") as HTMLInputElement).value   = creds?.email     ?? "";
      (document.getElementById("rm-field-password") as HTMLInputElement).value = "";
    }).catch(() => {});
    backdrop.classList.add("open");
    (document.getElementById("rm-field-url") as HTMLInputElement | null)?.focus();
  }

  function closeModal(): void {
    backdrop.classList.remove("open");
  }

  document.getElementById("rm-modal-cancel")?.addEventListener("click", closeModal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });

  document.getElementById("rm-modal-clear")?.addEventListener("click", () => {
    electronAPI.auth.clearCredentials().then(() => {
      showMsg("Cloud sync disconnected.", "success");
      setTimeout(closeModal, 1200);
    }).catch(() => {});
  });

  function readFields(): { url: string; clubId: string; email: string; password: string } | null {
    const url      = (document.getElementById("rm-field-url")      as HTMLInputElement).value.trim();
    const clubId   = (document.getElementById("rm-field-clubid")   as HTMLInputElement).value.trim();
    const email    = (document.getElementById("rm-field-email")    as HTMLInputElement).value.trim();
    const password = (document.getElementById("rm-field-password") as HTMLInputElement).value;
    if (!url || !clubId || !email || !password) {
      showMsg("All fields are required.", "error");
      return null;
    }
    return { url, clubId, email, password };
  }

  document.getElementById("rm-modal-test")?.addEventListener("click", () => {
    const fields = readFields();
    if (!fields) return;

    const btn = document.getElementById("rm-modal-test") as HTMLButtonElement;
    const saveBtn = document.getElementById("rm-modal-save") as HTMLButtonElement;
    btn.textContent = "Testing…";
    btn.disabled = true;
    saveBtn.disabled = true;

    electronAPI.auth
      .setCredentials(fields.email, fields.password, fields.url, fields.clubId)
      .then(() => electronAPI.sync.flush())
      .then(() => electronAPI.sync.getState())
      .then((state) => {
        if (state.status === "error") {
          showMsg(`Connection failed: ${state.lastError ?? "unknown error"}`, "error");
        } else {
          showMsg("Connection successful! Click Save & Connect to finish.", "success");
        }
      })
      .catch((err: unknown) => {
        showMsg(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      })
      .finally(() => {
        btn.textContent = "Test Connection";
        btn.disabled = false;
        saveBtn.disabled = false;
      });
  });

  document.getElementById("rm-modal-save")?.addEventListener("click", () => {
    const fields = readFields();
    if (!fields) return;

    const btn = document.getElementById("rm-modal-save") as HTMLButtonElement;
    const testBtn = document.getElementById("rm-modal-test") as HTMLButtonElement;
    btn.textContent = "Connecting…";
    btn.disabled = true;
    testBtn.disabled = true;

    electronAPI.auth
      .setCredentials(fields.email, fields.password, fields.url, fields.clubId)
      .then(() => electronAPI.sync.flush())
      .then(() => electronAPI.sync.getState())
      .then((state) => {
        if (state.status === "error") {
          showMsg(`Could not connect: ${state.lastError ?? "unknown error"}`, "error");
        } else {
          showMsg("Connected! Sync is running.", "success");
          setTimeout(closeModal, 1400);
        }
      })
      .catch((err: unknown) => {
        showMsg(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      })
      .finally(() => {
        btn.textContent = "Save & Connect";
        btn.disabled = false;
        testBtn.disabled = false;
      });
  });

  window.addEventListener("rm-open-sync-settings", openModal);
}

// ── Serial port settings modal ────────────────────────────────────────────────

function injectSerialModal(): void {
  const style = document.createElement("style");
  style.textContent = `
    #rm-serial-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 999998;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(3px);
      align-items: center;
      justify-content: center;
      font-family: system-ui, sans-serif;
    }
    #rm-serial-backdrop.open { display: flex; }
    #rm-serial-modal {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 10px;
      padding: 24px 28px;
      width: 380px;
      max-width: 95vw;
      color: #f1f5f9;
    }
    #rm-serial-modal h2 { margin: 0 0 16px; font-size: 15px; font-weight: 600; }
    #rm-serial-modal label {
      display: block;
      font-size: 12px;
      color: #94a3b8;
      margin-bottom: 4px;
      margin-top: 12px;
    }
    #rm-serial-modal select, #rm-serial-modal input {
      width: 100%;
      box-sizing: border-box;
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      border-radius: 5px;
      padding: 7px 10px;
      font-size: 13px;
    }
    .rm-serial-actions {
      display: flex;
      gap: 8px;
      margin-top: 20px;
      justify-content: flex-end;
    }
    .rm-serial-actions button {
      padding: 7px 16px;
      border-radius: 5px;
      border: none;
      font-size: 13px;
      cursor: pointer;
    }
    #rm-serial-cancel { background: #334155; color: #f1f5f9; }
    #rm-serial-connect { background: #3b82f6; color: #fff; font-weight: 600; }
    #rm-serial-disconnect { background: #ef4444; color: #fff; }
    #rm-serial-msg { font-size: 12px; margin-top: 10px; min-height: 16px; }
    #rm-serial-msg.error   { color: #f87171; }
    #rm-serial-msg.success { color: #4ade80; }
    #rm-serial-msg.hidden  { opacity: 0; }
    #rm-serial-status { font-size: 12px; color: #94a3b8; margin-top: 6px; }
  `;
  document.head.appendChild(style);

  const backdrop = document.createElement("div");
  backdrop.id = "rm-serial-backdrop";
  backdrop.innerHTML = `
    <div id="rm-serial-modal">
      <h2>RFID Reader — Serial Port</h2>
      <div id="rm-serial-status">Loading…</div>
      <label for="rm-serial-port">Port</label>
      <select id="rm-serial-port"><option value="">— select port —</option></select>
      <label for="rm-serial-baud">Baud rate</label>
      <input id="rm-serial-baud" type="number" value="9600" min="1200" max="115200" />
      <div id="rm-serial-msg" class="hidden"> </div>
      <div class="rm-serial-actions">
        <button id="rm-serial-cancel">Cancel</button>
        <button id="rm-serial-disconnect">Disconnect</button>
        <button id="rm-serial-connect">Connect</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  function showMsg(text: string, kind: "error" | "success"): void {
    const el = document.getElementById("rm-serial-msg");
    if (el) { el.textContent = text; el.className = kind; }
  }

  function refreshStatus(): void {
    electronAPI.serial.getStatus().then((s) => {
      const el = document.getElementById("rm-serial-status");
      if (!el) return;
      if (s.connected) {
        el.textContent = `Connected: ${s.portPath ?? ""}  ·  ${s.tagCount} tags read`;
      } else if (s.error) {
        el.textContent = `Error: ${s.error}`;
      } else {
        el.textContent = "Not connected";
      }
    }).catch(() => {});
  }

  function openSerialModal(): void {
    const msgEl = document.getElementById("rm-serial-msg");
    if (msgEl) { msgEl.textContent = " "; msgEl.className = "hidden"; }
    refreshStatus();
    electronAPI.serial.listPorts().then((ports) => {
      const sel = document.getElementById("rm-serial-port") as HTMLSelectElement;
      if (!sel) return;
      sel.innerHTML = `<option value="">— select port —</option>` +
        ports.map((p) => `<option value="${p.path}">${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ""}</option>`).join("");
    }).catch(() => {});
    backdrop.classList.add("open");
  }

  function closeSerialModal(): void {
    backdrop.classList.remove("open");
  }

  document.getElementById("rm-serial-cancel")?.addEventListener("click", closeSerialModal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeSerialModal(); });

  document.getElementById("rm-serial-disconnect")?.addEventListener("click", () => {
    electronAPI.serial.disconnect().then(() => {
      showMsg("Disconnected.", "success");
      refreshStatus();
    }).catch((err: unknown) => {
      showMsg(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
    });
  });

  document.getElementById("rm-serial-connect")?.addEventListener("click", () => {
    const port = (document.getElementById("rm-serial-port") as HTMLSelectElement).value;
    const baud = Number((document.getElementById("rm-serial-baud") as HTMLInputElement).value) || 9600;
    if (!port) { showMsg("Select a port first.", "error"); return; }
    const btn = document.getElementById("rm-serial-connect") as HTMLButtonElement;
    btn.textContent = "Connecting…"; btn.disabled = true;
    electronAPI.serial.connect(port, baud)
      .then(() => {
        showMsg("Connected!", "success");
        refreshStatus();
        setTimeout(closeSerialModal, 1200);
      })
      .catch((err: unknown) => {
        showMsg(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
      })
      .finally(() => { btn.textContent = "Connect"; btn.disabled = false; });
  });

  window.addEventListener("rm-open-serial-settings", openSerialModal);
}

/**
 * Auto-show the login modal on first launch (when no credentials are stored).
 * Gives the page 1 second to finish rendering before showing the overlay.
 */
function autoShowLoginIfNeeded(): void {
  electronAPI.auth.getCredentials().then((creds) => {
    if (!creds?.cloudUrl) {
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("rm-open-sync-settings"));
      }, 1000);
    }
  }).catch(() => {});
}
