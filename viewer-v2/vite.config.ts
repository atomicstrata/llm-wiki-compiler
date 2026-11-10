/**
 * Vite build for the v2 viewer client.
 *
 * The production build is copied into the viewer's asset bundle under `v2/`
 * and served by the existing `/assets/*` route, so every built URL is rooted at
 * `/assets/v2/`. In development the client runs on Vite's own server and
 * proxies `/api` to a running `llmwiki view` (set `LLMWIKI_VIEW_API` to its
 * URL), so the client is always exercised against the real JSON API.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_API_ORIGIN = "http://127.0.0.1:18881";
const BUILT_BASE_PATH = "/assets/v2/";

export default defineConfig(({ command }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: command === "build" ? BUILT_BASE_PATH : "/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: process.env.LLMWIKI_VIEW_API ?? DEFAULT_API_ORIGIN, changeOrigin: true },
    },
  },
}));
