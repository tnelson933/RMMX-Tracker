import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("connector", {
  getStatus: () => ipcRenderer.invoke("status:get"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  login: (input: { cloudUrl: string; email: string; password: string }) =>
    ipcRenderer.invoke("auth:login", input),
  listCloudReaders: () => ipcRenderer.invoke("readers:cloud"),
  scanNetwork: () => ipcRenderer.invoke("network:scan"),
  probeAddress: (address: string) => ipcRenderer.invoke("network:probe", address),
  addReader: (input: { address: string; hardware: string; readerId: number | null; name?: string }) =>
    ipcRenderer.invoke("reader:add", input),
  removeReader: (readerId: number) => ipcRenderer.invoke("reader:remove", readerId),
  renameReader: (readerId: number, name: string) => ipcRenderer.invoke("reader:rename", readerId, name),
  reconnectReader: (readerId: number) => ipcRenderer.invoke("reader:reconnect", readerId),
  testReader: (readerId: number, enabled: boolean) => ipcRenderer.invoke("reader:test", readerId, enabled),
  configureReader: (readerId: number, input: { channel: number; power: number; loop1Enabled: boolean; loop2Enabled: boolean; syncClock?: boolean }) =>
    ipcRenderer.invoke("reader:configure", readerId, input),
  setIdentifying: (enabled: boolean) => ipcRenderer.invoke("identify:set", enabled),
  logout: () => ipcRenderer.invoke("logout"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  onStatus: (cb: (status: unknown) => void) => {
    ipcRenderer.on("status:update", (_e, status) => cb(status));
  },
});
