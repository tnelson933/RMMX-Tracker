import { Router } from "express";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";

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

function buildPackageJson(): Buffer {
  const pkg = {
    name: "rocky-mountain-local-server",
    version: "1.0.0",
    type: "module",
    scripts: {
      start: "node --enable-source-maps ./dist/index.mjs",
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
3. Set the database file path (optional — defaults to \`./race_data.db\`):
   - macOS / Linux:  \`export SQLITE_FILE="./race_data.db"\`
   - Windows CMD:    \`set SQLITE_FILE=./race_data.db\`
4. Start the server:  \`npm start\`
5. Verify: open http://localhost:8080/api/healthz in a browser.
   You should see {"status":"ok","mode":"local"}.

## Point your timing hardware at:
   http://<your-laptop-ip>:8080/api/timing/active/crossing?clubId=<id>

## Notes
- Use http:// (NOT https://) — the local server has no TLS certificate.
- Keep this server running throughout race day.
- Do NOT delete race_data.db until you have confirmed a successful cloud sync.
- After race day: export via the Rocky Mountain cloud portal (Admin → Sync from Offline Export).
`;
  return Buffer.from(text, "utf8");
}

// ── Zip cache ─────────────────────────────────────────────────────────────────
// Cache the generated zip buffer keyed on the dist file's mtime (ms).
// Re-reads and rebuilds only when the file changes on disk.

let cachedZip: Buffer | null = null;
let cachedMtimeMs = -1;

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/offline/package", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // The API server always runs from its esbuild bundle at artifacts/api-server/dist/.
  // Three levels up from dist/ reaches the workspace root.
  const workspaceRoot = resolve(__dirname, "..", "..", "..");
  const distFile = resolve(
    workspaceRoot,
    "artifacts",
    "local-server",
    "dist",
    "index.mjs",
  );

  let zip: Buffer;
  try {
    const { mtimeMs } = statSync(distFile);
    if (cachedZip && mtimeMs === cachedMtimeMs) {
      zip = cachedZip;
    } else {
      const serverBundle = readFileSync(distFile);
      zip = buildZip([
        {
          name: "rocky-mountain-local-server/dist/index.mjs",
          data: serverBundle,
        },
        {
          name: "rocky-mountain-local-server/package.json",
          data: buildPackageJson(),
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

  res.setHeader(
    "Content-Disposition",
    'attachment; filename="rocky-mountain-local-server-latest.zip"',
  );
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", zip.length);
  res.send(zip);
});

export default router;
