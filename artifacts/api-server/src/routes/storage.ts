import express, { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";

const UPLOADS_DIR = path.join(process.cwd(), ".uploads");
// Ensure directory exists at module load time
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {});

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * POST /storage/uploads/file
 *
 * Direct binary file upload — accepts image as raw body, saves to local disk,
 * returns { objectPath } that the client can use to form the final URL.
 * Use x-file-name header to hint the desired filename/extension.
 */
router.post(
  "/storage/uploads/file",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "10mb" }),
  async (req: Request, res: Response) => {
    const originalName = (req.headers["x-file-name"] as string) || "upload.png";
    const contentType = (req.headers["x-content-type"] as string) || "image/png";
    const ext = path.extname(originalName) || ".png";
    const filename = `${randomUUID()}${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "No file data received" });
      return;
    }

    try {
      // Upload to cloud storage (persistent across redeployments)
      const cloudPath = await objectStorageService.uploadObjectEntityFromBuffer(req.body, contentType, ext);
      req.log.info({ size: req.body.length, contentType, cloudPath }, "File uploaded to object storage");

      // Also write to local disk using the same filename so /storage/uploads/:filename
      // can serve it directly without hitting cloud storage on every request.
      const cloudFilename = path.basename(cloudPath);
      fs.writeFile(path.join(UPLOADS_DIR, cloudFilename), req.body).catch((err) => {
        req.log.warn({ err }, "Could not write upload to local disk cache");
      });

      // Return the /uploads/ path — consistent with existing DB records and served
      // by GET /storage/uploads/:filename (disk-first with cloud fallback).
      const objectPath = `/uploads/${cloudFilename}`;
      res.json({ objectPath });
    } catch (error) {
      req.log.error({ err: error }, "Error uploading file to object storage");
      res.status(503).json({ error: "Storage unavailable — please try again" });
    }
  }
);

const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * GET /storage/uploads/:filename
 *
 * Serve uploaded files (logos, event images, etc.).
 * Tries local disk first (fast path), then falls back to Replit cloud object
 * storage so files survive production redeployments.
 */
router.get("/storage/uploads/:filename", async (req: Request, res: Response) => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  if (filename.includes("..") || filename.includes("/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const contentType = UPLOAD_CONTENT_TYPES[ext] ?? "application/octet-stream";

  // 1. Try local disk (fast, works in development and for cached production files)
  try {
    const data = await fs.readFile(path.join(UPLOADS_DIR, filename));
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(data);
    return;
  } catch {
    // Not on disk — fall through to cloud storage
  }

  // 2. Fall back to Replit cloud object storage (survives redeployments)
  try {
    const objectFile = await objectStorageService.getObjectEntityFile(`/objects/uploads/${filename}`);
    const cloudResponse = await objectStorageService.downloadObject(objectFile, 31536000);

    res.status(cloudResponse.status);
    cloudResponse.headers.forEach((value, key) => res.setHeader(key, value));

    if (cloudResponse.body) {
      const nodeStream = Readable.fromWeb(cloudResponse.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving upload from cloud storage");
    res.status(500).json({ error: "Failed to serve file" });
  }
});

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  try {
    const { name, size, contentType } = parsed.data;

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get("/storage/public-objects/*filePath", async (req: Request, res: Response) => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const response = await objectStorageService.downloadObject(file);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    // --- Protected route example (uncomment when using replit-auth) ---
    // if (!req.isAuthenticated()) {
    //   res.status(401).json({ error: "Unauthorized" });
    //   return;
    // }
    // const canAccess = await objectStorageService.canAccessObjectEntity({
    //   userId: req.user.id,
    //   objectFile,
    //   requestedPermission: ObjectPermission.READ,
    // });
    // if (!canAccess) {
    //   res.status(403).json({ error: "Forbidden" });
    //   return;
    // }

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, "Object not found");
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
