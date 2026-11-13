/**
 * @file Provider guards for commands that call an LLM.
 */

import { ensureCompileProviderAvailable, ensureProviderAvailable } from "@atomicstrata/llmwiki-core/modules/utils/provider-guard";

/**
 * Run the shared provider guard but match the legacy CLI error path:
 * print the error in red and exit 1 instead of letting the throw
 * surface as a stack trace. Programmatic callers use the underlying guards
 * directly so they can convert the throw into a structured envelope.
 */
export function requireProvider(): void {
  requireAvailableProvider(ensureProviderAvailable);
}

/** Run the compile-aware provider guard through the legacy CLI error path. */
export function requireCompileProvider(): void {
  requireAvailableProvider(ensureCompileProviderAvailable);
}

/** Print a provider-guard failure in red and exit through the legacy path. */
function requireAvailableProvider(ensureAvailable: () => void): void {
  try {
    ensureAvailable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mError:\x1b[0m ${message}`);
    process.exit(1);
  }
}
