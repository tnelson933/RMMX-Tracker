import express, { Router } from "express";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { randomUUID } from "crypto";

const router = Router();

const UPLOADS_DIR = path.join(process.cwd(), ".uploads");

// Ensure uploads dir exists at startup
try {
  fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch {
  // ignore
}

/**
 * POST /storage/uploads/file
 * Direct binary upload — accepts image as raw body, saves to .uploads/, returns { objectPath }.
 */
router.post(
  "/storage/uploads/file",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "10mb" }),
  async (req, res) => {
    const originalName = (req.headers["x-file-name"] as string) || "upload.png";
    const contentType = (req.headers["x-content-type"] as string) || "image/png";
    const ext = path.extname(originalName) || ".png";
    const filename = `${randomUUID()}${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "No file data received" });
    }

    try {
      await fs.writeFile(filepath, req.body);
      return res.json({ objectPath: `/uploads/${filename}` });
    } catch {
      return res.status(500).json({ error: "Failed to save file" });
    }
  },
);

const EXT_CONTENT_TYPE: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
};

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
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filepath = path.join(UPLOADS_DIR, filename);
  const ext = path.extname(filename).toLowerCase();

  // ── Try local disk first ────────────────────────────────────────────────
  try {
    const data = await fs.readFile(filepath);
    res.setHeader("Content-Type", EXT_CONTENT_TYPE[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(data);
  } catch {
    // Not on disk — fall through to cloud proxy
  }

  // ── Proxy to cloud when file only lives in cloud object storage ─────────
  const cloudUrl = (process.env.CLOUD_URL ?? "").replace(/\/$/, "");
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

  return res.status(404).json({ error: "File not found" });
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
