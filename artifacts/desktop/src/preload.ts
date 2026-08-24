import { contextBridge, ipcRenderer } from "electron";
import type {
  SyncState,
  SerialPortInfo,
  SerialStatus,
  ActiveTransponderStatus,
  ActiveTransponderConfiguration,
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

  activeTransponder: {
    connect: (ip?: string): Promise<void> =>
      ipcRenderer.invoke("active-transponder:connect", ip),
    disconnect: (): Promise<void> =>
      ipcRenderer.invoke("active-transponder:disconnect"),
    getStatus: (): Promise<ActiveTransponderStatus> =>
      ipcRenderer.invoke("active-transponder:getStatus"),
    startTest: (): Promise<void> =>
      ipcRenderer.invoke("active-transponder:startTest"),
    stopTest: (): Promise<void> =>
      ipcRenderer.invoke("active-transponder:stopTest"),
    configure: (configuration: ActiveTransponderConfiguration): Promise<void> =>
      ipcRenderer.invoke("active-transponder:configure", configuration),
    syncClock: (): Promise<void> =>
      ipcRenderer.invoke("active-transponder:syncClock"),
    onStatus: (cb: (status: ActiveTransponderStatus) => void): (() => void) => {
      const handler = (_: unknown, status: ActiveTransponderStatus) => cb(status);
      ipcRenderer.on("active-transponder:status", handler);
      return () => ipcRenderer.off("active-transponder:status", handler);
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
    sendMessage: (convId: number, content: string, eventId?: number): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke("ai:sendMessage", convId, content, eventId),
  },

  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),
    platform: process.platform,
  },

  // Called on-demand (not static) so it always reflects the current saved
  // credentials — even if the user just logged in during this session.
  // publicOrigin.ts calls this each time it builds a shareable URL so that
  // widget embeds and registration links always point at the cloud.
  getCloudUrl: (): string => ipcRenderer.sendSync("auth:getCloudUrlSync") as string,
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
