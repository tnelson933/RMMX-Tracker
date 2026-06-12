import { safeStorage, app } from "electron";
import path from "path";
import fs from "fs";
import type { CloudCredentials } from "./ipc-types";

const CREDS_FILE   = path.join(app.getPath("userData"), "credentials.enc");
const META_FILE    = path.join(app.getPath("userData"), "credentials.meta.json");
const SESSION_FILE = path.join(app.getPath("userData"), "session.enc");

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
      const encrypted = fs.readFileSync(CREDS_FILE);
      password = safeStorage.decryptString(encrypted);
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
