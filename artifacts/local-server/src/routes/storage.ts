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

/**
 * GET /storage/uploads/:filename
 * Serve locally-uploaded files (logos, event images, etc.) from disk.
 */
router.get("/storage/uploads/:filename", async (req, res) => {
  const filename = req.params.filename as string;
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filepath = path.join(UPLOADS_DIR, filename);
  try {
    const data = await fs.readFile(filepath);
    const ext = path.extname(filename).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };
    res.setHeader("Content-Type", contentTypeMap[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(data);
  } catch {
    return res.status(404).json({ error: "File not found" });
  }
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
