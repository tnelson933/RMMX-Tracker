import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, ".test-dist");

try {
  await build({
    entryPoints: {
      feibot: path.join(root, "src/feibot.ts"),
      "recent-read-deduper": path.join(root, "src/recent-read-deduper.ts"),
    },
    outdir,
    platform: "node",
    bundle: true,
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    logLevel: "silent",
  });
  execFileSync(process.execPath, ["--test", path.join(root, "test/feibot.test.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
} finally {
  await rm(outdir, { recursive: true, force: true });
}