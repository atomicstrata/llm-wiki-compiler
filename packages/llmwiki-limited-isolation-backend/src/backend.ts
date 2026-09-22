/**
 * @file packages/llmwiki-limited-isolation-backend/src/backend.ts
 * @description The v1 LIMITED-ISOLATION experiment backend. It implements the
 * same `ProviderHostBackendV1` contract as the dev backend, wrapping the
 * provider spawn with two enforced controls — deny network, confine writes to
 * scratch — via seatbelt (macOS) or bubblewrap (Linux), and FAILING CLOSED
 * when the isolation tool is unavailable.
 *
 * WHAT IT IS NOT: a security sandbox. Environment variables, inherited file
 * descriptors, /proc, and the process tree are NOT isolated; a timeout
 * terminates but does not prove a grandchild dead. It is for experiment code
 * the operator WROTE OR TRUSTS — the dev backend's contract, plus network-deny
 * and scratch confinement. Production isolation is a separate, later build.
 */

import { spawnSync } from "node:child_process";
import { providerLaunchEnv, resolveProviderEntrypoint } from "@atomicstrata/llmwiki-core";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchProviderChannel } from "llmwiki-dev-backend";
import type {
  ProviderHostBackendV1, ProviderLaunchDescriptorV1 as DevLaunchDescriptorV1,
} from "@atomicstrata/llmwiki-core";
import type {
  ProviderBackendChannelV1 as DevBackendChannelV1,
} from "@atomicstrata/llmwiki-core";
import { bubblewrapArgs, seatbeltProfile } from "./profile.js";

const DEFAULT_MAXIMUM_CAPTURED_STDERR_BYTES = 64 * 1024;

/** The refusal a caller sees when isolation cannot be applied (fail-closed). */
export class IsolationUnavailableError extends Error {
  constructor(reason: string) {
    super(`limited-isolation backend refuses: ${reason}`);
    this.name = "IsolationUnavailableError";
  }
}

/** Options: the interpreter, stderr cap, and a test seam for the isolation tool. */
export interface LimitedIsolationBackendOptionsV1 {
  readonly nodeExecPath?: string;
  readonly maximumCapturedStderrBytes?: number;
  /** Override the isolation binary name (tests point this at a missing tool). */
  readonly isolationToolOverride?: string;
}

/** True when `tool` is runnable on PATH — the fail-closed availability check. */
function toolAvailable(tool: string): boolean {
  const probe = spawnSync(tool, ["--help"], { stdio: "ignore" });
  // ENOENT surfaces as `error`; any spawnable binary (even nonzero exit) counts.
  return probe.error === undefined;
}


/** The command + args that launch the entrypoint under isolation for this OS. */
async function isolatedCommand(
  platform: NodeJS.Platform, tool: string, execPath: string, entrypoint: string,
  launchRoot: string, writableRoots: readonly string[],
): Promise<{ command: string; args: readonly string[] }> {
  if (platform === "darwin") {
    const profilePath = path.join(writableRoots[0]!, "seatbelt.sb");
    await writeFile(profilePath, seatbeltProfile(writableRoots), "utf8");
    return { command: tool, args: ["-f", profilePath, execPath, entrypoint] };
  }
  if (platform === "linux") {
    return { command: tool, args: [...bubblewrapArgs(writableRoots, launchRoot), execPath, entrypoint] };
  }
  throw new IsolationUnavailableError(`unsupported platform ${platform}`);
}

/** The default isolation tool for a platform, or undefined when unsupported. */
function defaultTool(platform: NodeJS.Platform): string | undefined {
  return platform === "darwin" ? "sandbox-exec" : platform === "linux" ? "bwrap" : undefined;
}

/** One resolved launch decision: the backend AND its availability answer, closed over the SAME tool. */
export interface LimitedIsolationLaunchPlanV1 {
  readonly backend: ProviderHostBackendV1;
  /** Ask, at the moment of use, whether the launch this plan's backend would attempt CAN succeed. */
  availability(): { available: true } | { available: false; reason: string };
}

/**
 * The PAIRED factory (D24-lite): a journey that wants to refuse an unavailable
 * isolation tool BY NAME before driving must ask the same resolved
 * platform/tool/options the backend will launch with — a free-standing
 * availability probe can inspect a different tool than the instance that runs,
 * and a pre-invoke answer expires across an arbitrarily long human review.
 * Callers re-ask `availability()` immediately before EACH drive; the residual
 * await-window race is accepted because the backend itself still fails closed
 * (only the refusal's NAME degrades, only in that window).
 *
 * THE BOUND OF THE ANSWER: `available: true` means exactly "the resolved tool
 * is runnable on PATH" — the same predicate the backend's own launch gate
 * uses. A tool that spawns but is barred from ISOLATING by host policy still
 * fails CLOSED at the real drive (the run parks; nothing executes
 * unsandboxed); only the refusal's earliness and name degrade in that case.
 */
export function limitedIsolationLaunchPlan(
  options: LimitedIsolationBackendOptionsV1 = {},
): LimitedIsolationLaunchPlanV1 {
  const tool = options.isolationToolOverride ?? defaultTool(process.platform);
  return {
    backend: limitedIsolationBackend(options),
    availability: () => {
      if (tool === undefined) return { available: false, reason: `unsupported platform ${process.platform}` };
      if (!toolAvailable(tool)) return { available: false, reason: `isolation tool ${JSON.stringify(tool)} is not runnable on PATH` };
      return { available: true };
    },
  };
}

/**
 * Build the limited-isolation backend.
 *
 * @param options - Interpreter, stderr cap, and the test-only tool override.
 * @returns A backend whose `launch` refuses (fail-closed) when isolation is
 *   unavailable, and otherwise runs the provider network-denied and
 *   write-confined to the scratch/output roots.
 */
export function limitedIsolationBackend(
  options: LimitedIsolationBackendOptionsV1 = {},
): ProviderHostBackendV1 {
  const execPath = options.nodeExecPath ?? process.execPath;
  const maximumCapturedStderrBytes =
    options.maximumCapturedStderrBytes ?? DEFAULT_MAXIMUM_CAPTURED_STDERR_BYTES;
  const platform = process.platform;
  const tool = options.isolationToolOverride ?? defaultTool(platform);
  return {
    async launch(descriptor: DevLaunchDescriptorV1): Promise<DevBackendChannelV1> {
      // FAIL CLOSED: no tool, unsupported platform, or an unrunnable tool
      // REFUSES. There is never a silent fallback to unsandboxed execution.
      if (tool === undefined) throw new IsolationUnavailableError(`no isolation tool for platform ${platform}`);
      if (!toolAvailable(tool)) throw new IsolationUnavailableError(`isolation tool '${tool}' is unavailable`);
      const entrypoint = resolveProviderEntrypoint(descriptor.launchRoot, descriptor.entrypointRelativePath);
      // CANONICAL roots: seatbelt (and bwrap binds) evaluate the resolved path,
      // so a symlinked tmpdir (/tmp -> /private/tmp on macOS) must be realpath'd
      // or the profile's writable subpath never matches the child's write.
      const outputRoot = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-exp-out-")));
      const scratchRoot = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-exp-scratch-")));
      const { command, args } = await isolatedCommand(
        platform, tool, execPath, entrypoint, descriptor.launchRoot, [scratchRoot, outputRoot]);
      return launchProviderChannel({
        command, args, cwd: descriptor.launchRoot,
        env: providerLaunchEnv(outputRoot, scratchRoot, descriptor.brokerResponseRegionMount),
        outputRoot, scratchRoots: [scratchRoot], maximumCapturedStderrBytes, wallTimeMs: descriptor.wallTimeMs,
      });
    },
  };
}
