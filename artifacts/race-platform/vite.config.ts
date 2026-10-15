import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

const PWA_RELEASE = "2026.08.27.1";

export default defineConfig(async ({ command }) => {
  const rawPort = process.env.PORT;
  const rawBasePath = process.env.BASE_PATH;

  if (command === "serve" && !rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = rawPort ? Number(rawPort) : undefined;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  if (command === "serve" && !rawBasePath) {
    throw new Error(
      "BASE_PATH environment variable is required but was not provided.",
    );
  }

  const basePath = rawBasePath ?? "/";

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: false,
      },
      includeAssets: ["favicon.svg", "rm-logo.png"],
      manifest: {
        name: "RM Tracker",
        short_name: "RM Tracker",
        description:
          "Live RFID timing, race scoring, and series points for ATV and motorcycle clubs.",
        theme_color: "#ea580c",
        background_color: "#020617",
        display: "standalone",
        icons: [
          {
            src: "rm-logo.png",
            sizes: "1788x1788",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "rm-logo.png",
            sizes: "1788x1788",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        importScripts: [`sw-auto-reload.js?v=${PWA_RELEASE}`],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/rider-app/],
        runtimeCaching: [],
      },
    }),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    ...(port !== undefined ? { port } : {}),
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: false,
    },
  },
  preview: {
    ...(port !== undefined ? { port } : {}),
    host: "0.0.0.0",
    allowedHosts: true,
  },
  };
});
