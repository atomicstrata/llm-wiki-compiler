#!/usr/bin/env node
/**
 * Copy the viewer's static assets from src/viewer/assets/ into
 * dist/viewer/assets/ so the published npm package ships the shell
 * template, stylesheet, and client script alongside the compiled CLI.
 * The v2 client is built by Vite into the bundle's `v2/` subdirectory.
 *
 * Wired through `tsup.config.ts` as `onSuccess`. Using Node's `fs.cp`
 * keeps the build portable beyond Unix shells (no `cp -r`), per the
 * Slice 3 asset-packaging decision in the spec.
 */

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { build } from "vite";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const source = path.join(projectRoot, "src/viewer/assets");
const target = path.resolve(projectRoot, process.argv[2] ?? "dist", "viewer/assets");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`viewer-assets: copied ${source} -> ${target}`);

// Build the v2 client straight into the bundle's `v2/` directory, which the
// `/assets/v2/*` route serves. It is built here, not as a separate step, so
// every path that runs tsup (build, watch, the test suite's global setup)
// produces it.
const v2Target = path.join(target, "v2");
await build({
  configFile: path.join(projectRoot, "viewer-v2/vite.config.ts"),
  logLevel: "warn",
  build: { outDir: v2Target, emptyOutDir: true },
});
console.log(`viewer-assets: built viewer-v2 -> ${v2Target}`);
