/**
 * after-pack.js — Rebuilds native Node.js modules for the target Electron version.
 * electron-builder runs this after packing but before signing.
 *
 * Rebuilds in TWO locations:
 *  1. resources/app[.asar.unpacked]/node_modules — Electron main process (serialport, better-sqlite3)
 *  2. resources/local-server/node_modules        — local Express server (better-sqlite3)
 *
 * Handles both asar (default in eb v25: resources/app.asar.unpacked) and
 * non-asar layouts (resources/app).
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

  console.log(`[after-pack] electronVersion=${electronVersion} arch=${archStr} (raw=${context.arch})`);
  console.log(`[after-pack] appOutDir=${appOutDir}`);

  // 1. Rebuild native modules used by the Electron main process.
  //    eb v25 defaults to asar, so unpacked natives land in app.asar.unpacked.
  //    Non-asar builds use app/ directly.
  const appPathCandidates = [
    path.join(appOutDir, "resources", "app"),
    path.join(appOutDir, "resources", "app.asar.unpacked"),
  ];
  const appPath = appPathCandidates.find((p) => fs.existsSync(p));

  if (appPath) {
    console.log(`[after-pack] Rebuilding native modules for Electron main process at: ${appPath}`);
    try {
      await rebuild({
        buildPath: appPath,
        electronVersion,
        arch: archStr,
        onlyModules: ["better-sqlite3", "serialport", "@serialport/bindings-cpp"],
        force: true,
      });
      console.log("[after-pack] Main process native module rebuild complete.");
    } catch (err) {
      console.error("[after-pack] ERROR rebuilding main process native modules:", err.message ?? err);
      throw err;
    }
  } else {
    console.log(`[after-pack] No app directory found at either candidate path — skipping main process rebuild.`);
    console.log(`[after-pack]   Checked: ${appPathCandidates.join(", ")}`);
  }

  // 2. Rebuild native modules bundled with the local-server (extraResources).
  //    These are always at resources/local-server regardless of asar mode.
  const localServerPath = path.join(appOutDir, "resources", "local-server");
  if (fs.existsSync(localServerPath)) {
    console.log(`[after-pack] Rebuilding native modules for local-server at: ${localServerPath}`);
    try {
      await rebuild({
        buildPath: localServerPath,
        electronVersion,
        arch: archStr,
        onlyModules: ["better-sqlite3"],
        force: true,
      });
      console.log("[after-pack] Local-server native module rebuild complete.");
    } catch (err) {
      console.error("[after-pack] ERROR rebuilding local-server native modules:", err.message ?? err);
      throw err;
    }
  } else {
    console.log(`[after-pack] local-server path not found (${localServerPath}), skipping.`);
  }

  console.log("[after-pack] All done.");
};
