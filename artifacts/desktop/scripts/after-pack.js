/**
 * after-pack.js — Rebuilds native Node.js modules for the target Electron version.
 * electron-builder runs this after packing but before signing.
 *
 * Requires @electron/rebuild to be installed.
 */

const { rebuild } = require("@electron/rebuild");
const path = require("path");

exports.default = async function (context) {
  const electronVersion = context.electronVersion;
  const appOutDir = context.appOutDir;

  await rebuild({
    buildPath: path.join(appOutDir, "resources", "app"),
    electronVersion,
    arch: context.arch,
    onlyModules: ["better-sqlite3", "serialport", "@serialport/bindings-cpp"],
    force: true,
  });
};
