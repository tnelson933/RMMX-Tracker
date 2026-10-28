/**
 * Persisted connector settings + encrypted credentials.
 *
 * Secrets (password, session cookie) are encrypted with Electron safeStorage.
 * Non-secret settings live in plain JSON in the app's userData directory.
 */
import { safeStorage, app } from "electron";
import path from "path";
import fs from "fs";
import { migrateSettings, type ConnectorSettings } from "./settings-migrations";
import { builtInCloudUrl, migrateCloudUrl } from "./cloud-url";

export type { ConnectorSettings, ReaderConfig, Hardware, ActiveTimingConfig } from "./settings-migrations";

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "connector-settings.json");
const LAPTOP_KEY_FILE = () => path.join(app.getPath("userData"), "laptop.enc");
// Older releases stored an organizer password and session; both are retired.
const PASSWORD_FILE = () => path.join(app.getPath("userData"), "credentials.enc");
const SESSION_FILE = () => path.join(app.getPath("userData"), "session.enc");

function defaultSettings(): ConnectorSettings {
  return { cloudUrl: builtInCloudUrl(), email: "", clubId: null, clubName: "", readers: [], autoConnect: true };
}

export function loadSettings(): ConnectorSettings {
  try {
    if (!fs.existsSync(SETTINGS_FILE())) return defaultSettings();
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    // Empty or retired (former Replit) URLs move to the built-in cloud URL,
    // and a single-reader file from an older release becomes a reader list.
    const normalized = migrateSettings(raw, migrateCloudUrl);
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: ConnectorSettings): void {
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), "utf8");
}

// ── Encrypted secrets ─────────────────────────────────────────────────────────

function saveEncrypted(file: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable() || !value) return;
  try {
    fs.writeFileSync(file, safeStorage.encryptString(value));
  } catch {
    // non-fatal
  }
}

function loadEncrypted(file: string): string | null {
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(file)) || null;
  } catch {
    return null;
  }
}

/** This laptop's key from pairing, encrypted with the OS keychain. */
export function saveLaptopKey(key: string): void {
  saveEncrypted(LAPTOP_KEY_FILE(), key);
}
export function loadLaptopKey(): string | null {
  return loadEncrypted(LAPTOP_KEY_FILE());
}
export function clearLaptopKey(): void {
  try { if (fs.existsSync(LAPTOP_KEY_FILE())) fs.unlinkSync(LAPTOP_KEY_FILE()); } catch { /* ignore */ }
}

/** Delete the organizer password and session older releases saved. */
export function clearLegacyCredentials(): void {
  for (const f of [PASSWORD_FILE(), SESSION_FILE()]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

export function clearAll(): void {
  for (const f of [LAPTOP_KEY_FILE(), PASSWORD_FILE(), SESSION_FILE(), SETTINGS_FILE()]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
}
