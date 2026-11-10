#!/usr/bin/env node
/**
 * Copy the viewer's static assets from src/viewer/assets/ into
 * dist/viewer/assets/ so the published npm package ships the shell
 * template, stylesheet, and client script alongside the compiled CLI.
 * The built v2 client (viewer-v2/dist) is copied into its `v2/` subdirectory.
 *
 * Wired through `tsup.config.ts` as `onSuccess`. Using Node's `fs.cp`
 * keeps the build portable beyond Unix shells (no `cp -r`), per the
 * Slice 3 asset-packaging decision in the spec.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const source = path.join(projectRoot, "src/viewer/assets");
const target = path.resolve(projectRoot, process.argv[2] ?? "dist", "viewer/assets");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`viewer-assets: copied ${source} -> ${target}`);

// The v2 client is built by Vite (`npm run build:viewer-v2`) before tsup runs.
// It ships inside the same bundle under `v2/`, so `/assets/v2/*` serves it.
const v2Source = path.join(projectRoot, "viewer-v2/dist");
const v2Target = path.join(target, "v2");
await rm(v2Target, { recursive: true, force: true });
await cp(v2Source, v2Target, { recursive: true });
console.log(`viewer-assets: copied ${v2Source} -> ${v2Target}`);
