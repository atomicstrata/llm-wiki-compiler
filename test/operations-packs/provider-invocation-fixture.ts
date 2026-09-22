/**
 * @file test/operations-packs/provider-invocation-fixture.ts
 * @description The host provider-invocation capability the pack runtime suites
 * drive with: a request that BINDS the phase's sealed executor.
 *
 * It is derived from the executor it is handed rather than restated as
 * constants, because the leg refuses any request whose pin, capability, schema
 * or exposure differs from the seal — a fixture carrying its own literals would
 * drift out of binding the first time a pack fixture changed its provider role,
 * and every suite would refuse for a reason unrelated to what it tests.
 */

import type { ProviderInvocationRequestV1 } from "../../src/capability-providers/runtime/invoke.js";
import type { ProviderLegInputV1 } from "../../src/preparations/attempts/provider.js";
import type { ProviderPhaseExecutorV1 } from "../../src/operations-packs/runtime/runner-input.js";

/** A request binding the given sealed executor, exposing no host content. */
export function bindingProviderRequest(
  executor: ProviderPhaseExecutorV1,
): ProviderInvocationRequestV1 {
  return {
    paths: { verification: "authorized-provider-roots" }, invocationId: "inv-1", nonce: "nonce-1",
    expectedIdentity: {
      providerPinDigest: executor.providerPinDigest, capabilityId: executor.capabilityId,
      capabilitySchemaDigest: executor.capabilityContractDigest,
    },
    authorityRequest: { capabilityId: executor.capabilityId },
    launch: {
      sourceTreeReal: "/src", launchParentDir: "/caller-launch",
      artifact: {
        entrypointRelativePath: "entry.js", digest: executor.providerPinDigest, archiveFormat: "tar",
        archiveByteCount: 1, expandedTreeDigest: executor.providerPinDigest, expandedByteCount: 1,
        entryCount: 1,
      },
    },
    // EMPTY input specs: a V1 provider phase receives its rendered request and no
    // host files, which is exactly the exposure the plan's authority seals.
    inputSpecs: [], input: null, operationContext: {}, declaredOutputs: [],
    custodyValidators: [], brokers: {},
  } as unknown as ProviderInvocationRequestV1;
}

/** The host capability's per-phase leg input, serving every provider phase. */
export function providerLegInputFor(executor: ProviderPhaseExecutorV1): ProviderLegInputV1 {
  return { request: bindingProviderRequest(executor), host: {} as never, preparationRunId: "run" };
}
