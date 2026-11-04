/**
 * Racer profile photos: what an upload may contain, and who may see them.
 */
import { effectiveVisibility } from "./riderResume";

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_KINDS = ["avatar", "cover"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export function photoKind(v: unknown): PhotoKind | null {
  return v === "avatar" || v === "cover" ? v : null;
}

/** JPEG, PNG or WebP, decided from the file's first bytes (never the client's type or name). */
export function sniffImage(buf: Buffer): { ext: ".jpg" | ".png" | ".webp"; contentType: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: ".jpg", contentType: "image/jpeg" };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: ".png", contentType: "image/png" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: ".webp", contentType: "image/webp" };
  return null;
}

export type PhotoCheck =
  | { ok: true; ext: string; contentType: string }
  | { ok: false; status: number; error: string };

export function checkPhoto(body: unknown): PhotoCheck {
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false, status: 400, error: "No photo was received. Choose the photo again and upload it." };
  if (body.length > PHOTO_MAX_BYTES) return { ok: false, status: 413, error: "That photo is too large. Choose one under 8 MB." };
  const img = sniffImage(body);
  if (!img) return { ok: false, status: 415, error: "Only JPEG, PNG or WebP photos can be used." };
  return { ok: true, ...img };
}

/**
 * The photos a viewer may see. Public profiles show them to everyone; private
 * ones (under-18 by default) only to the rider's own managers. Everyone else
 * gets nulls and falls back to initials and the stock photo.
 */
export function visiblePhotos(
  rider: { dateOfBirth: string | null; profileVisibility: string | null; avatarUrl: string | null; coverUrl: string | null },
  viewerManages: boolean,
  todayYmd: string,
): { avatarUrl: string | null; coverUrl: string | null } {
  if (!viewerManages && effectiveVisibility(rider, todayYmd) !== "public") return { avatarUrl: null, coverUrl: null };
  return { avatarUrl: rider.avatarUrl ?? null, coverUrl: rider.coverUrl ?? null };
}
