// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/api-server/src/lib/riderPhotos.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPhoto, photoKind, PHOTO_MAX_BYTES, sniffImage, visiblePhotos } from "./riderPhotos";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

test("sniff: JPEG, PNG and WebP by their bytes", () => {
  assert.equal(sniffImage(jpeg)?.contentType, "image/jpeg");
  assert.equal(sniffImage(png)?.ext, ".png");
  assert.equal(sniffImage(webp)?.ext, ".webp");
});

test("sniff: refuses SVG, GIF, HTML and text, whatever they're called", () => {
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), null);
  assert.equal(sniffImage(Buffer.from("GIF89a....")), null);
  assert.equal(sniffImage(Buffer.from("<html><body>hi</body></html>")), null);
  assert.equal(sniffImage(Buffer.from("RIFF0000WAVE")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("check: empty, too large, wrong type, ok", () => {
  assert.equal((checkPhoto(Buffer.alloc(0)) as { status: number }).status, 400);
  assert.equal((checkPhoto(undefined) as { status: number }).status, 400);
  assert.equal((checkPhoto({}) as { status: number }).status, 400);
  const big = Buffer.concat([jpeg, Buffer.alloc(PHOTO_MAX_BYTES)]);
  assert.equal((checkPhoto(big) as { status: number }).status, 413);
  assert.equal((checkPhoto(Buffer.from("not an image")) as { status: number }).status, 415);
  assert.deepEqual(checkPhoto(jpeg), { ok: true, ext: ".jpg", contentType: "image/jpeg" });
});

test("photo kind", () => {
  assert.equal(photoKind("avatar"), "avatar");
  assert.equal(photoKind("cover"), "cover");
  assert.equal(photoKind("banner"), null);
  assert.equal(photoKind(undefined), null);
});

test("privacy: private profiles show photos only to the rider's managers", () => {
  const today = "2026-11-04";
  const photos = { avatarUrl: "/api/storage/uploads/a.jpg", coverUrl: "/api/storage/uploads/c.jpg" };
  const adult = { dateOfBirth: "1990-01-01", profileVisibility: null, ...photos };
  const minor = { dateOfBirth: "2012-05-05", profileVisibility: null, ...photos };
  assert.deepEqual(visiblePhotos(adult, false, today), photos);
  assert.deepEqual(visiblePhotos(minor, false, today), { avatarUrl: null, coverUrl: null });
  assert.deepEqual(visiblePhotos(minor, true, today), photos);
  assert.deepEqual(visiblePhotos({ ...minor, profileVisibility: "public" }, false, today), photos);
  assert.deepEqual(visiblePhotos({ ...adult, profileVisibility: "private" }, false, today), { avatarUrl: null, coverUrl: null });
  assert.deepEqual(visiblePhotos({ ...adult, profileVisibility: "private" }, true, today), photos);
  assert.deepEqual(visiblePhotos({ ...adult, avatarUrl: null, coverUrl: null }, true, today), { avatarUrl: null, coverUrl: null });
});
