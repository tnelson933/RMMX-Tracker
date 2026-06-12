import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  const shared = {
    platform: "node",
    bundle: true,
    format: "cjs",
    outdir: distDir,
    external: [
      "electron",
      "*.node",
      "better-sqlite3",
      "serialport",
      "@serialport/bindings-cpp",
    ],
    logLevel: "info",
    sourcemap: "linked",
  };

  // Main process
  await esbuild({
    ...shared,
    entryPoints: [path.resolve(artifactDir, "src/main.ts")],
    outExtension: { ".js": ".js" },
  });

  // Preload script (must be CJS, no node integration)
  await esbuild({
    ...shared,
    entryPoints: [path.resolve(artifactDir, "src/preload.ts")],
    outExtension: { ".js": ".js" },
  });

  console.log("✓ Desktop build complete");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
