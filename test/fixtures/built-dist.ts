/**
 * Paths to the built bundles that integration tests run, and the import-graph
 * edges that tie those tests to the source the bundles are built from.
 *
 * `bun test --changed` selects a test file only when its imports reach a
 * changed file. A test that runs `dist/cli.js` in a subprocess, or imports
 * `dist/index.js` by path, never imports src/, so a src/ change would select
 * none of them. The never-called imports below are those missing edges: Bun's
 * scan records a dynamic import inside a function without loading the module.
 * Take every `dist/` entry path from this file so the edge comes with it.
 */

import path from "node:path";

/** Absolute path to the built CLI, bundled from src/cli.ts. */
export const CLI = path.resolve("dist/cli.js");

/** Absolute path to the built SDK, bundled from src/index.ts. */
export const SDK = path.resolve("dist/index.js");

void (() => import("../../src/cli.js"));
void (() => import("../../src/index.js"));
