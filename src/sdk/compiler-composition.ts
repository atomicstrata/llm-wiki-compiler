/**
 * Version-locked standard SDK composition support. The facade normalizes its
 * root once, then constructs core with the original options and grant properties.
 * Quiet output must use core's AsyncLocalStorage instance, not a bundled copy.
 */
export { createWikiCoreAtRoot } from "./core.js";
export { withQuiet } from "../utils/output.js";
export type * from "./core-types.js";
