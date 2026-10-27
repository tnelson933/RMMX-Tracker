const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Some machines configure pnpm with a short virtual store (`virtual-store-dir=.v`,
// used on Windows to avoid long paths). Packages then live in <repo>/.v, outside
// Metro's default watch folders, and Metro can't resolve even expo-router/entry.
const shortVirtualStore = path.resolve(__dirname, "../../.v");
if (fs.existsSync(shortVirtualStore)) {
  config.watchFolders = [...(config.watchFolders ?? []), shortVirtualStore];
}

// expo-notifications creates temp Android dirs during install that Metro tries
// to watch before they exist — exclude them to prevent ENOENT crash.
config.resolver = config.resolver ?? {};
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /.*expo-notifications.*_tmp_.*/,
];

module.exports = config;
