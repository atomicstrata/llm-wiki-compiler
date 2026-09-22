/**
 * @file test/capability-providers/custody-fixture.ts
 * @description Shared scaffolding for the streaming-custody suites: a scratch
 * output-root factory that writes named files and a default custodian-options
 * builder, so each custody test states only what it varies rather than repeating
 * the same setup block.
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { StreamingCustodianOptionsV1 } from "../../src/capability-providers/runtime/custodian.js";
import { useScratchDirs } from "./scratch-dirs.js";

/** Write `files` into a fresh scratch root and return its path. */
async function writeOutputRoot(
  scratch: (prefix: string) => Promise<string>, files: Record<string, string>,
): Promise<string> {
  const root = await scratch("llmwiki-custody-");
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(root, name), body);
  return root;
}

/** A tracked scratch-directory factory plus an output-root writer bound to it. */
export function useCustodyOutputRoots() {
  const scratch = useScratchDirs();
  return { scratch, outputRoot: (files: Record<string, string>) => writeOutputRoot(scratch, files) };
}

/** Default single-report custodian options, overridable per test. */
export function custodyOptions(
  root: string, overrides: Partial<StreamingCustodianOptionsV1> = {},
): StreamingCustodianOptionsV1 {
  return {
    outputRoot: root, declaredOutputs: [{ outputId: "report", required: true, mediaType: "application/json" }],
    scanBytes: 1_000, wallTimeMs: 10_000, ...overrides,
  };
}

/** One provider artifact claim naming the output id and its in-root token. */
export function artifactClaim(outputId: string, outputToken: string) {
  return { artifactClaims: [{ outputId, outputToken }] };
}
