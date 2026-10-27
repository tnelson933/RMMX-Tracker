/**
 * Cloud server the desktop app syncs with.
 *
 * CI bakes VITE_CLOUD_URL into the desktop build. When a build is made without
 * it, the desktop app falls back to the production server so cloud sign-in and
 * sync still work. Only use this in desktop (window.electronAPI) code paths:
 * the web app treats VITE_CLOUD_URL being set as "running in the desktop app".
 */
export const DEFAULT_DESKTOP_CLOUD_URL = "https://www.rmroost.com";

export const DESKTOP_CLOUD_URL: string =
  ((import.meta.env.VITE_CLOUD_URL as string | undefined) ?? "").trim().replace(/\/$/, "") ||
  DEFAULT_DESKTOP_CLOUD_URL;
