const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// expo-notifications creates temp Android dirs during install that Metro tries
// to watch before they exist — exclude them to prevent ENOENT crash.
config.resolver = config.resolver ?? {};
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : []),
  /.*expo-notifications.*_tmp_.*/,
];

module.exports = config;
