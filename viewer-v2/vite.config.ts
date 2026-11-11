/**
 * Vite build for the v2 viewer client.
 *
 * `scripts/copy-viewer-assets.mjs` builds the client into the viewer's asset
 * bundle under `v2/`, which the existing `/assets/*` route serves, so every
 * built URL is rooted at `/assets/v2/`. In development the client runs on Vite's own server and
 * proxies `/api` to a running `llmwiki view` (set `LLMWIKI_VIEW_API` to its
 * URL), so the client is always exercised against the real JSON API.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DEFAULT_API_ORIGIN = "http://127.0.0.1:18881";
const BUILT_BASE_PATH = "/assets/v2/";

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: command === "build" ? BUILT_BASE_PATH : "/",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: process.env.LLMWIKI_VIEW_API ?? DEFAULT_API_ORIGIN, changeOrigin: true },
    },
  },
}));
