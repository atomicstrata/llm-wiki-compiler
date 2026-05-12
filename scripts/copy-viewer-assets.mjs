#!/usr/bin/env node
/**
 * Copy the viewer's static assets from src/viewer/assets/ into
 * dist/viewer/assets/ so the published npm package ships the shell
 * template, stylesheet, and client script alongside the compiled CLI.
 *
 * Wired through `tsup.config.ts` as `onSuccess`. Using Node's `fs.cp`
 * keeps the build portable beyond Unix shells (no `cp -r`), per the
 * Slice 3 asset-packaging decision in the spec.
 */

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const source = path.join(projectRoot, "src/viewer/assets");
const target = path.join(projectRoot, "dist/viewer/assets");

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`viewer-assets: copied ${source} -> ${target}`);
