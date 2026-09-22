/**
 * @file src/capability-providers/runtime/inputs.ts
 * @description Invocation-private input materialization. The host derives every
 * input's digest and byte count, copies the bytes into a read-only inputs mount
 * of the invocation namespace, and mints an invocation-scoped opaque token the
 * provider addresses instead of any host path. Materialization runs BEFORE the
 * exposure digest is computed and the grant resolves (D6.3), so the exposure
 * digest returned here is the stable value the caller pins before the grant.
 */
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, opendir, realpath, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  MAX_MATERIALIZED_INPUT_BYTES, MAX_MATERIALIZED_INPUT_FILES, MAX_MATERIALIZED_INPUT_FILE_BYTES,
} from "../constants.js";
import { parseInputId, parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import { providerExposureDigest } from "../authority/exposure.js";
import type { ProviderInputRefV1 } from "../authority/types.js";
import type { RuntimeInputTokenDescriptorV1 } from "./types.js";

const INPUTS_DIRECTORY = "inputs";

/** One provider input the host has been asked to materialize by exact bytes. */
export interface ProviderInputSpecV1 {
  readonly inputId: string;
  readonly kind: string;
  readonly provenanceLabel: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly sourceAuthorityDigest?: Sha256Digest;
}

/** The materialized input set plus the stable exposure digest and disposer. */
export interface MaterializedProviderInputsV1 {
  readonly inputs: readonly ProviderInputRefV1[];
  readonly inputTokens: readonly RuntimeInputTokenDescriptorV1[];
  readonly exposureDigest: Sha256Digest;
  readonly sandboxMountRelative: string;
  dispose(): Promise<void>;
}

/** Copy each input into the read-only inputs mount and derive its exposure. */
export async function materializeProviderInputs(
  invocationNamespaceDir: string, specs: readonly ProviderInputSpecV1[],
): Promise<MaterializedProviderInputsV1> {
  if (specs.length > MAX_MATERIALIZED_INPUT_FILES) throw new Error("provider inputs exceed the materialized file ceiling");
  const inputsRoot = path.join(await realpath(invocationNamespaceDir), INPUTS_DIRECTORY);
  await mkdir(inputsRoot, { mode: 0o700 });
  try {
    const materialized = await materializeAll(inputsRoot, specs);
    return Object.freeze({
      inputs: materialized.inputs, inputTokens: materialized.inputTokens,
      exposureDigest: providerExposureDigest(materialized.inputs),
      sandboxMountRelative: INPUTS_DIRECTORY, dispose: () => disposeInputs(inputsRoot),
    });
  } catch (error) {
    await disposeInputs(inputsRoot).catch(() => {});
    throw error;
  }
}

async function materializeAll(inputsRoot: string, specs: readonly ProviderInputSpecV1[]) {
  const inputs: ProviderInputRefV1[] = [];
  const inputTokens: RuntimeInputTokenDescriptorV1[] = [];
  let aggregateBytes = 0;
  for (const spec of specs) {
    aggregateBytes += spec.bytes.byteLength;
    if (spec.bytes.byteLength > MAX_MATERIALIZED_INPUT_FILE_BYTES) throw new Error("provider input exceeds the per-file ceiling");
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAX_MATERIALIZED_INPUT_BYTES) {
      throw new Error("provider inputs exceed the aggregate byte ceiling");
    }
    const materialized = await materializeOne(inputsRoot, spec);
    inputs.push(materialized.ref);
    inputTokens.push(materialized.token);
  }
  return { inputs: Object.freeze(inputs), inputTokens: Object.freeze(inputTokens) };
}

async function materializeOne(inputsRoot: string, spec: ProviderInputSpecV1) {
  const inputId = parseInputId(spec.inputId);
  const token = `in-${randomBytes(16).toString("hex")}`;
  const handle = await open(path.join(inputsRoot, token), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o400);
  let digest: Sha256Digest;
  try {
    await handle.writeFile(spec.bytes);
    await handle.sync();
    digest = parseSha256Digest(`sha256:${createHash("sha256").update(spec.bytes).digest("hex")}`);
  } finally {
    await handle.close();
  }
  const ref: ProviderInputRefV1 = Object.freeze({
    inputId, kind: spec.kind, provenanceLabel: spec.provenanceLabel, mediaType: spec.mediaType,
    digest, byteCount: spec.bytes.byteLength, materializedToken: token,
    ...(spec.sourceAuthorityDigest === undefined ? {} : { sourceAuthorityDigest: spec.sourceAuthorityDigest }),
  });
  const descriptor: RuntimeInputTokenDescriptorV1 = Object.freeze({
    inputId, token, kind: spec.kind, mediaType: spec.mediaType, digest, byteCount: spec.bytes.byteLength,
  });
  return { ref, token: descriptor };
}

/** Thaw and remove the read-only inputs mount; cleanup failure stays visible. */
async function disposeInputs(inputsRoot: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(inputsRoot, 0o700).catch(() => {});
    const children = await opendir(inputsRoot).catch(() => null);
    if (children) for await (const child of children) {
      await chmod(path.join(inputsRoot, child.name), 0o600).catch(() => {});
    }
  }
  await rm(inputsRoot, { recursive: true, force: true });
}
