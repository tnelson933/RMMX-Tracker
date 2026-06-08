import { Router } from "express";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";
import { spawnSync } from "node:child_process";
import multer from "multer";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

// ── Minimal ZIP writer ────────────────────────────────────────────────────────
// Implements the ZIP 2.0 format using Node built-ins only (no extra packages).
// Files are stored with DEFLATE compression.

function crc32(buf: Buffer): number {
  // zlib.crc32 was added in Node 22; cast to any to avoid older @types/node
  return (zlibCrc32 as any)(buf) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let localOffset = 0;

  const modTime = 0;
  const modDate = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const useCompressed = compressed.length < entry.data.length;
    const compressedData = useCompressed ? compressed : entry.data;
    const compressionMethod = useCompressed ? 8 : 0;

    // ── Local file header ───────────────────────────────────────────────────
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);          // version needed (2.0)
    localHeader.writeUInt16LE(0, 6);           // flags
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(modTime, 10);
    localHeader.writeUInt16LE(modDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);          // extra field length
    nameBytes.copy(localHeader, 30);

    localHeaders.push(localHeader);
    localHeaders.push(compressedData);

    // ── Central directory header ────────────────────────────────────────────
    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);          // version made by
    centralHeader.writeUInt16LE(20, 6);          // version needed
    centralHeader.writeUInt16LE(0, 8);           // flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(modTime, 12);
    centralHeader.writeUInt16LE(modDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);  // extra
    centralHeader.writeUInt16LE(0, 32);  // comment
    centralHeader.writeUInt16LE(0, 34);  // disk start
    centralHeader.writeUInt16LE(0, 36);  // internal attrs
    centralHeader.writeUInt32LE(0, 38);  // external attrs
    centralHeader.writeUInt32LE(localOffset, 42); // local header offset
    nameBytes.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    localOffset += localHeader.length + compressedData.length;
  }

  const centralDirBuf = Buffer.concat(centralHeaders);
  const centralDirOffset = localOffset;

  // ── End of central directory ────────────────────────────────────────────
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, centralDirBuf, eocd]);
}

// ── Package contents ──────────────────────────────────────────────────────────

// Version string encodes the build timestamp so organizers can compare their
// downloaded copy against the current server build.
function buildVersion(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}.${hh}${min}`;
}

function buildPackageJson(mtimeMs: number): Buffer {
  const pkg = {
    name: "rocky-mountain-local-server",
    version: buildVersion(mtimeMs),
    builtAt: new Date(mtimeMs).toISOString(),
    type: "module",
    scripts: {
      start: "node --enable-source-maps ./dist/index.mjs",
      sync:  "node --enable-source-maps ./dist/sync.mjs",
    },
    dependencies: {
      bcryptjs: "^3.0.3",
      "better-sqlite3": "^11.5.0",
      cors: "^2.8.6",
      express: "^5.2.1",
      "express-session": "^1.19.0",
    },
  };
  return Buffer.from(JSON.stringify(pkg, null, 2) + "\n", "utf8");
}

function buildReadme(): Buffer {
  const text = `# Rocky Mountain Race — Local Server

Self-contained offline race server for use at venues without internet access.

## Quick Start

1. Make sure Node.js 20+ is installed: \`node --version\`
2. Install dependencies:  \`npm install\`
3. Configure environment variables (see sections below).
4. Start the server:  \`npm start\`
5. Verify: open http://localhost:8080/api/healthz in a browser.
   You should see {"status":"ok","mode":"local"}.

## Point your timing hardware at:
   http://<your-laptop-ip>:8080/api/timing/active/crossing?clubId=<id>

## Environment Variables

### Basic setup (optional)

| Variable      | Default            | Description                         |
|---------------|--------------------|-------------------------------------|
| \`SQLITE_FILE\` | \`./race_data.db\`   | Path to the local SQLite database   |
| \`PORT\`        | \`8080\`             | Port the local server listens on    |
| \`CLUB_ID\`     | _(none)_           | Your club's numeric ID from the cloud portal |

### Auto-sync (optional but recommended)

Set these variables to enable automatic background sync to the cloud after
each completed event. The server will attempt a sync every 2 minutes once
a completed event is detected and the cloud is reachable.

| Variable          | Description                                              |
|-------------------|----------------------------------------------------------|
| \`CLOUD_URL\`       | Base URL of the Rocky Mountain cloud portal, e.g. \`https://your-replit-app.replit.app\` |
| \`CLOUD_EMAIL\`     | Email address of your organizer account                  |
| \`CLOUD_PASSWORD\`  | Password for your organizer account                      |
| \`CLUB_ID\`         | Your club's numeric ID (required for auto-sync)          |

#### Setting variables

macOS / Linux:
\`\`\`
export CLUB_ID=1
export CLOUD_URL=https://your-app.replit.app
export CLOUD_EMAIL=you@yourclub.com
export CLOUD_PASSWORD=yourpassword
npm start
\`\`\`

Windows CMD:
\`\`\`
set CLUB_ID=1
set CLOUD_URL=https://your-app.replit.app
set CLOUD_EMAIL=you@yourclub.com
set CLOUD_PASSWORD=yourpassword
npm start
\`\`\`

Windows PowerShell:
\`\`\`
$env:CLUB_ID=1
$env:CLOUD_URL="https://your-app.replit.app"
$env:CLOUD_EMAIL="you@yourclub.com"
$env:CLOUD_PASSWORD="yourpassword"
npm start
\`\`\`

## Manual Sync

If auto-sync is not configured, run this after race day to push results to the cloud:

\`\`\`
npm run sync
\`\`\`

## Notes
- Use http:// (NOT https://) — the local server has no TLS certificate.
- Keep this server running throughout race day.
- Do NOT delete race_data.db until you have confirmed a successful cloud sync.
- Auto-sync status is visible on the organizer dashboard once results are uploaded.
`;
  return Buffer.from(text, "utf8");
}

// ── Source staleness check & auto-rebuild ─────────────────────────────────────
// The local-server source lives at artifacts/local-server/src/.
// When any .ts file there is newer than dist/index.mjs, we rebuild via
// `node build.mjs` so the download always reflects the latest code.

function getMaxSourceMtime(srcDir: string): number {
  let max = 0;
  try {
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else if (entry.name.endsWith(".ts")) {
          const { mtimeMs } = statSync(full);
          if (mtimeMs > max) max = mtimeMs;
        }
      }
    };
    scan(srcDir);
  } catch {
    // If we can't read src, return 0 so we don't block serving an existing dist
  }
  return max;
}

function rebuildLocalServer(localServerDir: string): void {
  const result = spawnSync("node", ["build.mjs"], {
    cwd: localServerDir,
    stdio: "pipe",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    const stdout = result.stdout?.toString() ?? "";
    throw new Error(
      `Local server rebuild failed (exit ${result.status}):\n${stderr || stdout}`,
    );
  }
}

// ── Multer upload — store in OS temp dir ──────────────────────────────────────
const upload = multer({
  dest: join(tmpdir(), "rmmx-offline-uploads"),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (_req, file, cb) => {
    const allowed = [".db", ".zip"];
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf("."));
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .db and .zip files are accepted"));
    }
  },
});

// ── Zip cache ─────────────────────────────────────────────────────────────────
// Cache the generated zip buffer keyed on the dist file's mtime (ms).
// Re-reads and rebuilds only when the file changes on disk.

let cachedZip: Buffer | null = null;
let cachedMtimeMs = -1;
let isRebuilding = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function distFilePath(): string {
  // The API server always runs from its esbuild bundle at artifacts/api-server/dist/.
  // Three levels up from dist/ reaches the workspace root.
  const workspaceRoot = resolve(__dirname, "..", "..", "..");
  return resolve(
    workspaceRoot,
    "artifacts",
    "local-server",
    "dist",
    "index.mjs",
  );
}

function getDistMtime(): number {
  return statSync(distFilePath()).mtimeMs;
}

// ETag is a hex-encoded truncated mtime, stable across requests for the same build.
function mtimeToETag(mtimeMs: number): string {
  return `"${Math.floor(mtimeMs).toString(16)}"`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /offline/package-info — lightweight metadata about the current build.
// Used by the Offline Mode page to display build date without downloading the zip.
router.get("/offline/package-info", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const mtimeMs = getDistMtime();
    res.json({
      builtAt: new Date(mtimeMs).toISOString(),
      version: buildVersion(mtimeMs),
      etag: mtimeToETag(mtimeMs),
    });
  } catch {
    res.status(503).json({
      error:
        "Offline package is not available yet — the local server has not been built.",
    });
  }
});

// GET /offline/package — download the zip bundle.
router.get("/offline/package", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  if (isRebuilding) {
    res.status(503).json({
      error: "Offline package is being rebuilt — please try again in a moment.",
    });
    return;
  }

  const workspaceRoot = resolve(__dirname, "..", "..", "..");
  const localServerDir = resolve(workspaceRoot, "artifacts", "local-server");
  const srcDir = resolve(localServerDir, "src");
  const distIndexFile = distFilePath();
  const distSyncFile = resolve(localServerDir, "dist", "sync.mjs");

  // Check staleness and rebuild if any source file is newer than the dist bundle
  try {
    const srcMtime = getMaxSourceMtime(srcDir);
    let distMtime = -1;
    try {
      distMtime = statSync(distIndexFile).mtimeMs;
    } catch {
      // dist doesn't exist yet — needs a build
    }

    if (srcMtime > distMtime) {
      req.log.info("Local server source is newer than dist — rebuilding…");
      isRebuilding = true;
      try {
        rebuildLocalServer(localServerDir);
        cachedZip = null; // invalidate cache after rebuild
        cachedMtimeMs = -1;
      } finally {
        isRebuilding = false;
      }
      req.log.info("Local server rebuild complete.");
    }
  } catch (err) {
    isRebuilding = false;
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to rebuild local server");
    res.status(503).json({
      error: `Offline package could not be built: ${msg}`,
    });
    return;
  }

  let zip: Buffer;
  let mtimeMs: number;
  try {
    ({ mtimeMs } = statSync(distIndexFile));
    if (cachedZip && mtimeMs === cachedMtimeMs) {
      zip = cachedZip;
    } else {
      const serverBundle = readFileSync(distIndexFile);
      const syncBundle   = readFileSync(distSyncFile);
      zip = buildZip([
        {
          name: "rocky-mountain-local-server/dist/index.mjs",
          data: serverBundle,
        },
        {
          name: "rocky-mountain-local-server/dist/sync.mjs",
          data: syncBundle,
        },
        {
          name: "rocky-mountain-local-server/package.json",
          data: buildPackageJson(mtimeMs),
        },
        {
          name: "rocky-mountain-local-server/README.md",
          data: buildReadme(),
        },
      ]);
      cachedZip = zip;
      cachedMtimeMs = mtimeMs;
    }
  } catch {
    res.status(503).json({
      error:
        "Offline package is not available yet — the local server has not been built. " +
        "Please contact support or try again later.",
    });
    return;
  }

  const etag = mtimeToETag(mtimeMs!);
  const lastModified = new Date(mtimeMs!).toUTCString();

  // Support conditional GET so browsers can detect a newer build without
  // re-downloading the full zip.
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader(
    "Content-Disposition",
    'attachment; filename="rocky-mountain-local-server-latest.zip"',
  );
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", zip.length);
  res.setHeader("Last-Modified", lastModified);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  res.send(zip);
});

router.post("/offline/sync-upload", (req, res, next) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  upload.single("export")(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err.message ?? "File upload failed." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file received. Please attach a .db or .zip export file." });
      return;
    }
    const { originalname, size, path: tempPath, mimetype } = req.file;
    const clubId = (req.session as any).clubId ?? "unknown";
    req.log.info(
      { userId, clubId, filename: originalname, sizeBytes: size, tempPath, mimetype },
      "offline sync upload received",
    );
    res.json({
      received: true,
      message:
        `Upload received (${originalname}, ${(size / 1024).toFixed(1)} KB). ` +
        "An admin will process the import and merge the data into the live database. " +
        "Results will appear publicly once the import is complete.",
    });
  });
});

export default router;
