import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { ObjectStorageService } from "./objectStorage";

// UPLOADS_DIR should point at persistent storage (e.g. a Docker volume) off Replit.
export const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(process.cwd(), ".uploads");
// Replit object storage is only reachable when its bucket env is provisioned;
// elsewhere the disk copy is the only copy and cloud calls are skipped.
export const cloudStorageEnabled = Boolean(process.env.PRIVATE_OBJECT_DIR);

// Ensure directory exists at module load time
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {});

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/**
 * Save an uploaded file under a random name: to local disk first (immediately
 * serveable), then best-effort to object storage when it's provisioned.
 * Returns "/uploads/<file>", served by GET /api/storage/uploads/:filename.
 * The caller decides the content type and extension (never the client).
 */
export async function saveUpload(body: Buffer, contentType: string, ext: string, log: Log, objectStorage = new ObjectStorageService()): Promise<string> {
  const filename = `${randomUUID()}${ext}`;
  await fs.writeFile(path.join(UPLOADS_DIR, filename), body);
  log.info({ size: body.length, contentType, filename }, "File written to local disk");
  if (cloudStorageEnabled) {
    try {
      const cloudPath = await objectStorage.uploadObjectEntityFromBuffer(body, contentType, ext, filename);
      log.info({ cloudPath }, "File also uploaded to object storage");
    } catch (cloudErr) {
      log.warn({ err: cloudErr }, "Object storage unavailable — file saved to disk only");
    }
  }
  return `/uploads/${filename}`;
}
