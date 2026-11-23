import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";
import type { Plugin } from "vite";

const PWA_RELEASE = "2026.08.27.1";

// Files outside assets/ that the offline app shell needs, besides the favicons
// in includeAssets (the rest of public/,
// such as the large hero/og images and the 512px install icon, is fetched on
// demand and kept by the runtime image cache).
const PRECACHED_PUBLIC_FILES = new Set([
  "index.html",
  "sw-auto-reload.js",
  "registerSW.js",
  "manifest.webmanifest",
  "icon-192.png",
  "brand/rm-roost-banner-640.png",
  "brand/rmatv-wordmark.svg",
]);

/**
 * Records the files the first page load needs: the entry chunk, the chunks it
 * imports statically, and their CSS and assets. Only these are precached by
 * the service worker; pages and libraries loaded on demand (organizer portal,
 * PDF, spreadsheets, background removal) are cached the first time they're used.
 */
function appShellFiles(): { plugin: Plugin; files: Set<string> } {
  const files = new Set<string>();
  const plugin: Plugin = {
    name: "rmroost-app-shell-files",
    apply: "build",
    generateBundle(_options, bundle) {
      files.clear();
      const visit = (fileName: string) => {
        if (files.has(fileName)) return;
        const item = bundle[fileName];
        if (!item) return;
        files.add(fileName);
        if (item.type !== "chunk") return;
        item.imports.forEach(visit);
        item.viteMetadata?.importedCss.forEach((f) => files.add(f));
        item.viteMetadata?.importedAssets.forEach((f) => files.add(f));
      };
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk" && item.isEntry) visit(item.fileName);
      }
    },
  };
  return { plugin, files };
}

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

  // Off Replit there is no platform router joining the web app and API on one
  // origin, so local dev opts into a same-origin /api proxy (incl. WebSockets).
  const devApiProxy = process.env.DEV_API_PROXY;
  const appShell = appShellFiles();

  return {
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    appShell.plugin,
    VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: false,
      },
      // rm-logo.png (250 KB) is only on a few pages: the runtime image cache keeps it.
      includeAssets: ["favicon-32.png", "favicon-48.png", "apple-touch-icon.png"],
      manifest: {
        name: "RM Roost",
        short_name: "RM Roost",
        description:
          "Live RFID timing, race scoring, and series points for ATV and motorcycle clubs.",
        theme_color: "#242424",
        background_color: "#ffffff",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // The manifest icons are listed in PRECACHED_PUBLIC_FILES as needed.
      includeManifestIcons: false,
      workbox: {
        importScripts: [`sw-auto-reload.js?v=${PWA_RELEASE}`],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        // Precache the app shell only (see appShellFiles). Before code
        // splitting every visitor's first load also downloaded ~9 MB of
        // organizer pages, PDF/AI libraries and images in the background.
        manifestTransforms: [
          async (entries) => ({
            manifest: entries.filter((e) => {
              const url = e.url.replace(/^\//, "");
              return url.startsWith("assets/") ? appShell.files.has(url) : PRECACHED_PUBLIC_FILES.has(url);
            }),
            warnings: [],
          }),
        ],
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/rider-app/],
        runtimeCaching: [
          {
            // Code and styles loaded on demand. File names carry a content
            // hash, so a cached copy never goes stale; keeping earlier
            // releases' files also lets a tab opened before a release finish
            // loading its pages. The 24 MB onnxruntime .wasm is left to the
            // browser's HTTP cache.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.startsWith("/assets/") && /\.(m?js|css)$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "rmroost-code",
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 60, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
              plugins: [
                {
                  // A missing file can come back as the index.html fallback
                  // (status 200): never keep that under a code file's name.
                  cacheWillUpdate: async ({ response }) =>
                    /text\/html/i.test(response.headers.get("content-type") ?? "") ? null : response,
                },
              ],
            },
          },
          {
            urlPattern: ({ url, sameOrigin, request }) =>
              sameOrigin && request.destination === "image" && !url.pathname.startsWith("/api/"),
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "rmroost-images",
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
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
    rollupOptions: {
      output: {
        // Code splitting otherwise produces dozens of sub-1 KB chunks (one per
        // shared icon), each a separate request on a phone. Merge them.
        experimentalMinChunkSize: 8_000,
      },
    },
  },
  server: {
    ...(port !== undefined ? { port } : {}),
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: false,
    },
    ...(devApiProxy
      ? {
          proxy: {
            "/api": { target: devApiProxy, changeOrigin: false, ws: true },
          },
        }
      : {}),
  },
  preview: {
    ...(port !== undefined ? { port } : {}),
    host: "0.0.0.0",
    allowedHosts: true,
    ...(devApiProxy
      ? {
          proxy: {
            "/api": { target: devApiProxy, changeOrigin: false, ws: true },
          },
        }
      : {}),
  },
  };
});
