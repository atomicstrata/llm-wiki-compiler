/**
 * Paths to the built bundles that integration tests run. Take every `dist/`
 * entry path from this file so it is defined in one place.
 */

import path from "node:path";

/** Absolute path to the built CLI, bundled from src/cli.ts. */
export const CLI = path.resolve("dist/cli.js");

/** Absolute path to the built SDK, bundled from src/index.ts. */
export const SDK = path.resolve("dist/index.js");
