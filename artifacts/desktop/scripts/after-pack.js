/**
 * after-pack.js — Rebuilds native Node.js modules for the target Electron version.
 * electron-builder runs this after packing but before signing.
 *
 * Rebuilds in TWO locations:
 *  1. resources/app/node_modules         — Electron main process (serialport, better-sqlite3)
 *  2. resources/local-server/node_modules — local Express server (better-sqlite3)
 *
 * Requires @electron/rebuild to be installed.
 */

const { rebuild } = require("@electron/rebuild");
const path = require("path");
const fs = require("fs");

// electron-builder passes context.arch as a numeric enum:
//   ia32=0, x64=1, armv7l=2, arm64=3, universal=4
// @electron/rebuild expects a string ("x64", "arm64", etc.)
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

exports.default = async function (context) {
  const electronVersion = context.electronVersion;
  const appOutDir = context.appOutDir;
  const archStr = ARCH_NAMES[context.arch] ?? "x64";

  console.log(`[after-pack] electronVersion=${electronVersion} arch=${archStr} (raw=${context.arch})`);
  console.log(`[after-pack] appOutDir=${appOutDir}`);

  // 1. Rebuild native modules used by the Electron main process
  const appPath = path.join(appOutDir, "resources", "app");
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

  // 2. Rebuild native modules bundled with the local-server (extraResources)
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
