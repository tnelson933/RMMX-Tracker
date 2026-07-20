import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("connector", {
  getStatus: () => ipcRenderer.invoke("status:get"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  login: (input: { cloudUrl: string; email: string; password: string }) =>
    ipcRenderer.invoke("auth:login", input),
  listReaders: () => ipcRenderer.invoke("readers:list"),
  createReader: (input: { name: string; type: "rfid" | "mylaps" }) =>
    ipcRenderer.invoke("readers:create", input),
  connect: (input: { readerId: number; hardware: "impinj" | "zebra" | "generic" | "mylaps"; hardwareAddress: string }) =>
    ipcRenderer.invoke("connect", input),
  disconnect: () => ipcRenderer.invoke("disconnect"),
  toggleTest: (enabled: boolean) => ipcRenderer.invoke("test:toggle", enabled),
  logout: () => ipcRenderer.invoke("logout"),
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  onStatus: (cb: (status: unknown) => void) => {
    ipcRenderer.on("status:update", (_e, status) => cb(status));
  },
});
