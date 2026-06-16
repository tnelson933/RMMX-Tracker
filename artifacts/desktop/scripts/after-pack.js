/**
 * after-pack.js — Rebuilds native Node.js modules for the local-server extraResources.
 *
 * electron-builder's built-in @electron/rebuild already handles native modules
 * in the Electron main process (better-sqlite3, serialport in node_modules/).
 * This script only needs to rebuild the local-server's native deps, which are
 * copied via extraResources and are NOT touched by the built-in rebuild step.
 */

const { rebuild } = require("@electron/rebuild");
const path = require("path");
const fs = require("fs");

// electron-builder passes context.arch as a numeric enum:
//   ia32=0, x64=1, armv7l=2, arm64=3, universal=4
// @electron/rebuild expects a string ("x64", "arm64", etc.)
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

exports.default = async function (context) {
  // electron-builder v25 removed electronVersion from the afterPack context.
  // Try several paths, then fall back to reading from the installed electron package.
  const electronVersion =
    context.electronVersion ??
    context.packager?.electronVersion ??
    context.packager?.info?.framework?.version ??
    JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "node_modules", "electron", "package.json"),
        "utf8"
      )
    ).version;

  const appOutDir = context.appOutDir;
  const archStr = ARCH_NAMES[context.arch] ?? "x64";

  console.log(`[after-pack] electronVersion=${electronVersion} arch=${archStr}`);
  console.log(`[after-pack] appOutDir=${appOutDir}`);

  // Rebuild native modules bundled with the local-server (extraResources).
  // These live at resources/local-server regardless of asar mode and are NOT
  // rebuilt by electron-builder's built-in @electron/rebuild step.
  const localServerPath = path.join(appOutDir, "resources", "local-server");
  if (fs.existsSync(localServerPath)) {
    console.log(`[after-pack] Rebuilding local-server native modules at: ${localServerPath}`);
    try {
      await rebuild({
        buildPath: localServerPath,
        electronVersion,
        arch: archStr,
        onlyModules: ["better-sqlite3"],
        force: true,
      });
      console.log("[after-pack] Local-server rebuild complete.");
    } catch (err) {
      console.error("[after-pack] ERROR rebuilding local-server native modules:", err.message ?? err);
      throw err;
    }
  } else {
    console.log(`[after-pack] local-server path not found (${localServerPath}), skipping.`);
  }

  console.log("[after-pack] Done.");
};
