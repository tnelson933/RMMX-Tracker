import express, { Router } from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { CLOUD_URL } from "../lib/cloud-url";
import { cloudBaseUrl, getCloudAuthHeader, hasCloudCredentials } from "../lib/cloud-session";
import { getDb } from "../db";

const router = Router();

const UPLOADS_DIR = path.join(process.cwd(), ".uploads");

// Ensure uploads dir exists at startup
try {
  fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch {
  // ignore
}

/** Upload types accepted (the same as the cloud): raster images and PDFs. */
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const EXT_CONTENT_TYPE = UPLOAD_CONTENT_TYPES;

// Files saved here that the cloud doesn't have yet. A file uploaded on the
// desktop (club logo, event image, waiver PDF) must also reach the cloud, or
// riders on the website would never see it. It is sent under the same name, so
// the link already saved with the club or event stays valid.
function pendingUploads(): Array<{ filename: string }> {
  const db = getDb();
  db.exec("CREATE TABLE IF NOT EXISTS _pending_uploads (filename TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')), attempts INTEGER NOT NULL DEFAULT 0)");
  return db.prepare("SELECT filename FROM _pending_uploads ORDER BY created_at").all() as Array<{ filename: string }>;
}

let sending = false;
/** Send every waiting file to the cloud. Quietly does nothing while offline. */
export async function sendPendingUploads(): Promise<void> {
  if (sending || !hasCloudCredentials()) return;
  sending = true;
  try {
    for (const { filename } of pendingUploads()) {
      const ext = path.extname(filename).toLowerCase();
      let body: Buffer;
      try {
        body = await fs.readFile(path.join(UPLOADS_DIR, filename));
      } catch {
        getDb().prepare("DELETE FROM _pending_uploads WHERE filename = ?").run(filename); // file is gone
        continue;
      }
      let res: Response;
      try {
        res = await fetch(`${cloudBaseUrl()}/api/storage/uploads/file`, {
          method: "POST",
          headers: {
            ...(await getCloudAuthHeader()),
            "Content-Type": UPLOAD_CONTENT_TYPES[ext] ?? "application/octet-stream",
            "x-file-name": filename,
            "x-upload-name": filename,
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        // Offline (or the sign-in failed): try again later.
        console.warn(`[uploads] ${filename} not sent to the cloud yet: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (res.ok) {
        getDb().prepare("DELETE FROM _pending_uploads WHERE filename = ?").run(filename);
      } else {
        getDb().prepare("UPDATE _pending_uploads SET attempts = attempts + 1 WHERE filename = ?").run(filename);
        console.warn(`[uploads] the cloud refused ${filename} (${res.status}); it stays on this computer and will be retried`);
        if (res.status === 401) return;
      }
    }
  } finally {
    sending = false;
  }
}

// Retry while anything is waiting (a no-op when the list is empty or offline).
setInterval(() => { void sendPendingUploads().catch(() => {}); }, 60_000).unref?.();

/**
 * POST /storage/uploads/file
 * Direct binary upload: an image or a PDF as the raw body. Saved on this
 * computer (so it works offline) and sent to the cloud under the same name.
 * Same rules and messages as the cloud's route.
 */
router.post(
  "/storage/uploads/file",
  express.raw({ type: ["image/*", "application/pdf", "application/octet-stream"], limit: "20mb" }),
  async (req, res) => {
    const originalName = (req.headers["x-file-name"] as string) || "upload.png";
    const ext = (path.extname(originalName) || ".png").toLowerCase();
    if (!UPLOAD_CONTENT_TYPES[ext]) {
      return res.status(415).json({ error: "Only PNG, JPEG, GIF, WebP images or PDF files can be uploaded." });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "No file was received. Choose the file again and upload it." });
    }
    const filename = `${randomUUID()}${ext}`;
    try {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      await fs.writeFile(path.join(UPLOADS_DIR, filename), req.body);
    } catch (err) {
      console.error("[uploads] could not save the file", err);
      return res.status(503).json({ error: "File storage isn't responding. Try again in a moment." });
    }
    try {
      pendingUploads();
      getDb().prepare("INSERT OR IGNORE INTO _pending_uploads (filename) VALUES (?)").run(filename);
    } catch (err) {
      console.error("[uploads] could not queue the file for the cloud", err);
    }
    void sendPendingUploads().catch(() => {});
    return res.json({ objectPath: `/uploads/${filename}` });
  },
);

/**
 * GET /storage/uploads/:filename
 * Serve locally-uploaded files (logos, event images, etc.) from disk.
 * If the file is not stored locally (e.g. it was uploaded on the cloud and
 * the event was pulled to this desktop), transparently proxy the request to
 * the configured CLOUD_URL so images from the cloud app still display.
 */
router.get("/storage/uploads/:filename", async (req, res) => {
  const filename = req.params.filename as string;
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "That file name isn't allowed. Rename the file and upload it again." });
  }
  const filepath = path.join(UPLOADS_DIR, filename);
  const ext = path.extname(filename).toLowerCase();

  // ── Try local disk first ────────────────────────────────────────────────
  try {
    const data = await fs.readFile(filepath);
    res.setHeader("Content-Type", EXT_CONTENT_TYPE[ext] ?? "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!EXT_CONTENT_TYPE[ext]) res.setHeader("Content-Disposition", "attachment");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(data);
  } catch {
    // Not on disk — fall through to cloud proxy
  }

  // ── Proxy to cloud when file only lives in cloud object storage ─────────
  const cloudUrl = CLOUD_URL;
  if (cloudUrl) {
    try {
      const ctrl   = new AbortController();
      const timer  = setTimeout(() => ctrl.abort(), 10_000);
      const remote = await fetch(
        `${cloudUrl}/api/storage/uploads/${encodeURIComponent(filename)}`,
        { signal: ctrl.signal },
      );
      clearTimeout(timer);

      if (remote.ok) {
        const contentType = remote.headers.get("content-type")
          ?? EXT_CONTENT_TYPE[ext]
          ?? "application/octet-stream";
        const buffer = await remote.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        // Cache for 1 hour so repeated loads are fast but the image can
        // be refreshed if it changes on the cloud.
        res.setHeader("Cache-Control", "public, max-age=3600");
        return res.send(Buffer.from(buffer));
      }
    } catch {
      // Cloud unreachable — fall through to 404
    }
  }

  return res.status(404).json({ error: "This file couldn't be found. It may have been deleted. Refresh the page and try again." });
});

/**
 * POST /storage/uploads/request-url
 * Cloud-only (needs object storage service). Not available on desktop.
 */
router.post("/storage/uploads/request-url", (_req, res) => {
  return res.status(503).json({
    error: "Presigned URL upload is not available in offline mode. Use direct upload instead.",
  });
});

export default router;
