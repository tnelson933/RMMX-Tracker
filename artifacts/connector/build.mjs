import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { rm, cp, readFile } from "node:fs/promises";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  const packageJson = JSON.parse(await readFile(path.resolve(artifactDir, "package.json"), "utf8"));
  await rm(distDir, { recursive: true, force: true });

  const shared = {
    platform: "node",
    bundle: true,
    format: "cjs",
    outdir: distDir,
    external: ["electron"],
    logLevel: "info",
    sourcemap: "linked",
    define: {
      // Baked in by CI from the CLOUD_URL repo variable so users never type the URL.
      // Empty means src/cloud-url.ts falls back to https://www.rmroost.com.
      __DEFAULT_CLOUD_URL__: JSON.stringify((process.env.CLOUD_URL ?? "").trim()),
      __CONNECTOR_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
    },
  };

  await esbuild({
    ...shared,
    entryPoints: [path.resolve(artifactDir, "src/main.ts")],
  });

  await esbuild({
    ...shared,
    entryPoints: [path.resolve(artifactDir, "src/preload.ts")],
  });

  // Static settings UI
  await cp(
    path.resolve(artifactDir, "ui"),
    path.resolve(distDir, "ui"),
    { recursive: true },
  );

  console.log(`✓ Connector ${packageJson.version} build complete (CLOUD_URL: ${(process.env.CLOUD_URL ?? "").trim() || "unset, app falls back to https://www.rmroost.com"})`);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
