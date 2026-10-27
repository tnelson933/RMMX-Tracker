import { safeStorage, app } from "electron";
import path from "path";
import fs from "fs";
import type { CloudCredentials } from "./ipc-types";

const CREDS_FILE   = path.join(app.getPath("userData"), "credentials.enc");
const META_FILE    = path.join(app.getPath("userData"), "credentials.meta.json");
const SESSION_FILE = path.join(app.getPath("userData"), "session.enc");

/**
 * The production cloud server. Used when nothing else is configured, and as
 * the replacement for cloud URLs saved by builds that pointed at the retired
 * Replit deployment.
 */
export const DEFAULT_CLOUD_URL = "https://www.rmroost.com";

// Hosts of the retired Replit deployment (e.g. rmmx-tracker.replit.app).
const LEGACY_CLOUD_HOST_SUFFIXES = [".replit.app", ".replit.dev", ".repl.co"];

export function isLegacyCloudUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return LEGACY_CLOUD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Returns the cloud URL to use, replacing a missing or retired one with the default. */
export function resolveCloudUrl(raw: string | null | undefined): string {
  const trimmed = String(raw ?? "").trim().replace(/\/$/, "");
  if (!trimmed || isLegacyCloudUrl(trimmed)) return DEFAULT_CLOUD_URL;
  return trimmed;
}

export interface StoredCredentials {
  email: string;
  password: string;
  cloudUrl: string;
  clubId: string;
}

// ── Credentials (email + encrypted password) ─────────────────────────────────

export function saveCredentials(creds: StoredCredentials): void {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(creds.password);
    fs.writeFileSync(CREDS_FILE, encrypted);
  }
  const meta = { email: creds.email, cloudUrl: creds.cloudUrl, clubId: creds.clubId };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
  // Invalidate any cached session token whenever credentials change
  clearSessionCookie();
}

export function loadCredentials(): StoredCredentials | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as {
      email: string;
      cloudUrl: string;
      clubId: string;
    };
    let password = "";
    if (fs.existsSync(CREDS_FILE) && safeStorage.isEncryptionAvailable()) {
      try {
        password = safeStorage.decryptString(fs.readFileSync(CREDS_FILE));
      } catch (err) {
        // The OS key no longer opens the saved password (on macOS the Keychain
        // entry is named after the app, which changed with the RM Roost
        // rename). Keep the email, club and cloud URL; signing in again saves
        // a password the current key can read.
        console.warn(
          "[auth] Saved cloud password could not be decrypted; sign in again to restore cloud sync:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return { ...meta, password };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
  if (fs.existsSync(META_FILE))  fs.unlinkSync(META_FILE);
  clearSessionCookie();
}

export function getPublicCredentials(): CloudCredentials | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as {
      email: string;
      cloudUrl: string;
      clubId: string;
    };
    return {
      email:       meta.email,
      cloudUrl:    meta.cloudUrl,
      clubId:      meta.clubId,
      hasPassword: fs.existsSync(CREDS_FILE),
    };
  } catch {
    return null;
  }
}

/**
 * One-time startup migration: installs that saved a cloud URL on the retired
 * Replit deployment are pointed at the built-in production URL. The cached
 * session belongs to the old server, so it is dropped. Returns true when the
 * saved settings were changed.
 */
export function migrateLegacyCloudUrl(): boolean {
  try {
    if (!fs.existsSync(META_FILE)) return false;
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as Record<string, unknown>;
    const saved = typeof meta.cloudUrl === "string" ? meta.cloudUrl : "";
    if (!isLegacyCloudUrl(saved)) return false;
    meta.cloudUrl = DEFAULT_CLOUD_URL;
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf8");
    clearSessionCookie();
    console.log(`[auth] Migrated saved cloud URL from ${saved} to ${DEFAULT_CLOUD_URL}`);
    return true;
  } catch (err) {
    console.error(
      "[auth] Could not migrate the saved cloud URL:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// ── Session cookie (encrypted; avoids re-login on every app restart) ──────────

/**
 * Persist a session cookie to disk, encrypted with Electron safeStorage.
 * Called after a successful login so subsequent startups can reuse the
 * existing server session rather than re-sending the password.
 */
export function saveSessionCookie(cookie: string): void {
  if (!safeStorage.isEncryptionAvailable() || !cookie) return;
  try {
    const encrypted = safeStorage.encryptString(cookie);
    fs.writeFileSync(SESSION_FILE, encrypted);
  } catch {
    // Non-fatal — will fall back to password login on next startup
  }
}

/**
 * Load the persisted session cookie, or null if none / decryption fails.
 */
export function loadSessionCookie(): string | null {
  if (!fs.existsSync(SESSION_FILE) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(SESSION_FILE);
    const cookie = safeStorage.decryptString(encrypted);
    return cookie || null;
  } catch {
    return null;
  }
}

export function clearSessionCookie(): void {
  if (fs.existsSync(SESSION_FILE)) {
    try { fs.unlinkSync(SESSION_FILE); } catch { /* ignore */ }
  }
}
