/**
 * @file packages/llmwiki-dev-backend/src/backend.ts
 * @description A LOCAL DEVELOPMENT provider backend: it runs a capability
 * provider as an ordinary child process of the host.
 *
 * IT PROVIDES NO ISOLATION, AND THAT IS THE WHOLE CAVEAT. The launched provider
 * runs with the invoking user's full privileges and the invoking user's view of
 * the filesystem. It is for a provider you wrote and can read, on your own
 * machine. It is NOT the sandbox the provider runtime's backend contract
 * describes, and it must not be used to run a provider obtained from anyone
 * else.
 *
 * IT IS ABSENT UNLESS A HOST ASKS FOR IT. Nothing in the platform constructs
 * this; `llmwiki` ships no default backend, so a provider phase refuses until an
 * embedder passes one in. That is why this lives in its own package outside
 * `src` rather than behind a flag in the platform — a backend that could be
 * switched on by configuration would be one misread setting away from running
 * untrusted code unisolated.
 *
 * WHAT IT DOES OWE THE RUNTIME is execution correctness, not security: launch
 * with no shell so nothing in a path or argument is interpreted, resolve the
 * entrypoint strictly inside the verified package tree, bound the wall clock so
 * a hung provider cannot hold a run open, and bound captured stderr so a chatty
 * one cannot exhaust memory.
 */

import { providerLaunchEnv, resolveProviderEntrypoint } from "@atomicstrata/llmwiki-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchProviderChannel } from "./channel.js";
import type {
  ProviderHostBackendV1, ProviderLaunchDescriptorV1 as DevLaunchDescriptorV1,
} from "@atomicstrata/llmwiki-core";
import type {
  ProviderBackendChannelV1 as DevBackendChannelV1,
} from "@atomicstrata/llmwiki-core";

/** The runtime's backend shape, structurally: one launch returning a channel. */


/** Tunables a host may override; every default is the conservative one. */
export interface UnsandboxedLocalBackendOptionsV1 {
  /** The interpreter to launch. Defaults to the host's own Node binary. */
  readonly nodeExecPath?: string;
  /** Head of stderr retained for human diagnosis. */
  readonly maximumCapturedStderrBytes?: number;
}

const DEFAULT_MAXIMUM_CAPTURED_STDERR_BYTES = 64 * 1024;


/**
 * Build a local development provider backend.
 *
 * @param options - Optional interpreter and stderr-capture overrides.
 * @returns A backend that runs each provider as a child process, UNISOLATED.
 */
export function unsandboxedLocalBackend(
  options: UnsandboxedLocalBackendOptionsV1 = {},
): ProviderHostBackendV1 {
  const execPath = options.nodeExecPath ?? process.execPath;
  const maximumCapturedStderrBytes =
    options.maximumCapturedStderrBytes ?? DEFAULT_MAXIMUM_CAPTURED_STDERR_BYTES;
  return {
    async launch(descriptor: DevLaunchDescriptorV1): Promise<DevBackendChannelV1> {
      const entrypoint = resolveProviderEntrypoint(descriptor.launchRoot, descriptor.entrypointRelativePath);
      const outputRoot = await mkdtemp(path.join(tmpdir(), "llmwiki-provider-out-"));
      // The SAME provider-facing env contract the limited-isolation backend
      // speaks: a provider needing a working area (e.g. the experiment
      // executor materializing code) reads LLMWIKI_PROVIDER_SCRATCH_ROOT and
      // must run identically under either operator-chosen backend.
      const scratchRoot = await mkdtemp(path.join(tmpdir(), "llmwiki-provider-scratch-"));
      return launchProviderChannel({
        command: execPath, args: [entrypoint], cwd: descriptor.launchRoot,
        env: providerLaunchEnv(outputRoot, scratchRoot, descriptor.brokerResponseRegionMount),
        outputRoot, scratchRoots: [scratchRoot], maximumCapturedStderrBytes, wallTimeMs: descriptor.wallTimeMs,
      });
    },
  };
}
