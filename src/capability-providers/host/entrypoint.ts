/**
 * @file src/capability-providers/host/entrypoint.ts
 * @description The ONE entrypoint-confinement check every provider backend
 * shares. The provider tree was verified by the installer, but the entrypoint
 * PATH is a string carried alongside it — a `..` segment would execute a file
 * the verification never covered. This is an execution-correctness check: run
 * the thing that was actually verified, not merely something reachable from
 * it. One home, so the dev and limited-isolation backends can never drift on
 * what they refuse to launch.
 */
import path from "node:path";

/** Resolve the entrypoint strictly inside the verified package tree, or throw. */
export function resolveProviderEntrypoint(launchRoot: string, entrypointRelativePath: string): string {
  const root = path.resolve(launchRoot);
  const resolved = path.resolve(root, entrypointRelativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("provider entrypoint resolves outside the verified package tree");
  }
  return resolved;
}

/** The provider-facing env contract every backend speaks identically. */
export function providerLaunchEnv(
  outputRoot: string, scratchRoot: string, brokerResponseRegionMount: string,
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    LLMWIKI_PROVIDER_OUTPUT_ROOT: outputRoot,
    LLMWIKI_PROVIDER_SCRATCH_ROOT: scratchRoot,
    LLMWIKI_PROVIDER_BROKER_REGION: brokerResponseRegionMount,
  };
}
