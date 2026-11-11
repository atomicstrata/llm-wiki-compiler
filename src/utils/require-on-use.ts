/**
 * Synchronous on-demand loading for heavy packages.
 *
 * A static import is paid for by every command, because the module graph is
 * loaded before any command runs. Call sites that are asynchronous use a
 * dynamic `import()` instead. This helper is for the ones that are not: a
 * constructor, a synchronous validator, a renderer. Node resolves the package
 * the first time the call runs and caches it afterwards.
 *
 * Always pass a string literal. The package-boundary test reads every
 * `requireOnUse("...")` call in the built output and holds the named package
 * to the same declared-dependency rule as an import.
 */

import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/**
 * Load `specifier` now and return its CommonJS export object.
 *
 * @param specifier - A literal package specifier, as it would appear in an import.
 * @returns What `require(specifier)` returns; the caller states its shape as `T`.
 */
export function requireOnUse<T>(specifier: string): T {
  return nodeRequire(specifier) as T;
}
