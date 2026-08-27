/**
 * Persisted connector settings + encrypted credentials.
 *
 * Secrets (password, session cookie) are encrypted with Electron safeStorage.
 * Non-secret settings live in plain JSON in the app's userData directory.
 */
import { safeStorage, app } from "electron";
import path from "path";
import fs from "fs";
import { migrateLegacyActiveTransponderAddress } from "./settings-migrations";

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "connector-settings.json");
const PASSWORD_FILE = () => path.join(app.getPath("userData"), "credentials.enc");
const SESSION_FILE = () => path.join(app.getPath("userData"), "session.enc");

export interface ConnectorSettings {
  cloudUrl: string;
  email: string;
  clubId: number | null;
  readerId: number | null;
  readerToken: string | null;
  readerName: string | null;
  hardware: "impinj" | "zebra" | "generic" | "active_transponder" | null;
  /** Impinj: last 6 MAC chars OR a full hostname/IP. F2000: host/IP[:port]. */
  hardwareAddress: string;
  /** Reconnect hardware + cloud automatically when the app launches. */
  autoConnect: boolean;
  /** F2000 V3.2 active-transponder configuration. */
  activeTimingChannel: number;
  activeTimingPower: number;
  activeTimingLoop1Enabled: boolean;
  activeTimingLoop2Enabled: boolean;
}

const DEFAULT_SETTINGS: ConnectorSettings = {
  cloudUrl: "",
  email: "",
  clubId: null,
  readerId: null,
  readerToken: null,
  readerName: null,
  hardware: null,
  hardwareAddress: "",
  autoConnect: true,
  activeTimingChannel: 0,
  activeTimingPower: 100,
  activeTimingLoop1Enabled: true,
  activeTimingLoop2Enabled: true,
};

export function loadSettings(): ConnectorSettings {
  try {
    if (!fs.existsSync(SETTINGS_FILE())) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
    // Preserve existing installations while migrating both the former decoder
    // hardware kind and its obsolete F2000 TCP port.
    const hardware = raw.hardware === "mylaps" ? "active_transponder" : raw.hardware;
    const hardwareAddress = migrateLegacyActiveTransponderAddress(hardware, raw.hardwareAddress);
    // Older releases persisted vendor-prefixed configuration keys. Compose
    // those names so the retired vendor token never appears in source.
    const legacyPrefix = ["fei", "bot"].join("");
    const legacy = (suffix: string) => raw[legacyPrefix + suffix];
    const migrated = {
      ...raw,
      hardware,
      hardwareAddress,
      activeTimingChannel: raw.activeTimingChannel ?? legacy("Channel") ?? DEFAULT_SETTINGS.activeTimingChannel,
      activeTimingPower: raw.activeTimingPower ?? legacy("Power") ?? DEFAULT_SETTINGS.activeTimingPower,
      activeTimingLoop1Enabled: raw.activeTimingLoop1Enabled ?? legacy("Loop1Enabled") ?? DEFAULT_SETTINGS.activeTimingLoop1Enabled,
      activeTimingLoop2Enabled: raw.activeTimingLoop2Enabled ?? legacy("Loop2Enabled") ?? DEFAULT_SETTINGS.activeTimingLoop2Enabled,
    };
    for (const suffix of ["Channel", "Power", "Loop1Enabled", "Loop2Enabled"]) {
      delete migrated[legacyPrefix + suffix];
    }
    const normalized = { ...DEFAULT_SETTINGS, ...migrated };
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  } catch {
    return { ...DEFAULT_SETTINGS };
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

export function savePassword(password: string): void {
  saveEncrypted(PASSWORD_FILE(), password);
}
export function loadPassword(): string | null {
  return loadEncrypted(PASSWORD_FILE());
}

export function saveSessionCookie(cookie: string): void {
  saveEncrypted(SESSION_FILE(), cookie);
}
export function loadSessionCookie(): string | null {
  return loadEncrypted(SESSION_FILE());
}

export function clearAll(): void {
  for (const f of [PASSWORD_FILE(), SESSION_FILE(), SETTINGS_FILE()]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
}
