/**
 * @file test/limited-isolation/seam-fixture.ts
 * @description Shared harness for the limited-isolation INTEGRATION witness:
 * one probe provider installed through the platform's real install, one pack
 * action compiled against its real pin, and one invocation host assembled by
 * the STANDARD backend-selection seam (`devProviderInvocation`) with the
 * limited-isolation backend as the operator-chosen `backend`.
 *
 * NOTHING HERE IS BACKEND-SPECIFIC MACHINERY: every constructor is the same one
 * the unsandboxed journey uses, with only the `backend` argument different —
 * which is exactly the claim under test, that selecting the limited-isolation
 * backend is one argument at the existing seam and no new platform surface.
 *
 * The GENERIC demo pack is deliberate (§4.6): the witness proves the seam for
 * any pack-side execution, not for one product's vocabulary.
 */

import { expect } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreparation } from "../../src/index.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { CompiledPackActionV1 } from "../../src/operations-packs/compiler-types.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import {
  devProviderInvocation, installDevProvider, issueDevProviderGrant,
} from "../../src/capability-providers/host/index.js";
import type { ProviderHostBackendV1 } from "../../src/capability-providers/host/backend-contract.js";
import {
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "../capability-providers/resolution-fixture.js";
import { installProviderFromSource } from "../capability-providers/source-install-fixture.js";
import { providerIngestRecipe, requestWithRecipe } from "../operations-packs/compile-fixture.js";
import {
  phaseStates, readPhaseOutput, resultReason, runnerContext, type StagedPackRunV1,
} from "../operations-packs/runtime-fixture.js";
import { probeProviderSource } from "./probe-provider.js";

/** The installed probe provider and the fixture whose roots hold it. */
export interface ProbeProviderV1 {
  readonly fixture: ResolutionFixture;
  readonly installed: Awaited<ReturnType<typeof installDevProvider>>;
}

/**
 * Install the probe provider through the platform's real install path.
 *
 * The resolution fixture is removed if the INSTALL fails: the caller only
 * learns about it through the returned handle, so a rejection here would
 * otherwise leave a root nothing owns — the failing-setup leak, as opposed to
 * the failing-assertion one an `afterEach` already covers.
 */
export async function installProbeProvider(): Promise<ProbeProviderV1> {
  const fixture = await installResolutionFixture();
  try {
    const installed = await installProviderFromSource(fixture.paths, probeProviderSource(), "probe-provider-");
    return { fixture, installed };
  } catch (error) {
    await removeResolutionFixture(fixture).catch(() => undefined);
    throw error;
  }
}

/** Compile the GENERIC provider-ingest action pinned to the probe provider. */
export function compileProbeAction(
  provider: ProbeProviderV1, topic: string,
): Promise<CompiledPackActionV1> {
  const base = { ...requestWithRecipe(providerIngestRecipe()), input: { topic } };
  const { installed } = provider;
  return compilePackAction({
    ...base,
    pack: {
      ...base.pack,
      providerRequirements: [{
        roleId: "primary-model", disposition: "required",
        capabilityId: String(installed.pin.capabilityId),
        capabilityContractDigest: String(installed.pin.capabilitySchemaDigest),
        allowedProviderPins: [installed.providerPinDigest],
        defaultProviderPin: installed.providerPinDigest,
        requiredReadinessDimensions: [], requestedGrantKinds: [],
        fallbackPolicy: { kind: "refuse" },
        requestedBounds: {
          maxBrokerRequestsPerAttempt: 0, maxTokensPerAttempt: 4096,
          maxCostMicrosPerAttempt: 25_000, maxWallTimeMsPerAttempt: 30_000,
        },
      }],
    },
  } as never);
}

/**
 * The STANDARD seam, with the caller's backend as the one operator decision:
 * grant issued for THIS project, invocation host assembled by the same
 * constructor every other backend goes through.
 */
export async function probeInvocation(
  provider: ProbeProviderV1, root: string, backend: ProviderHostBackendV1,
): Promise<ReturnType<typeof devProviderInvocation>> {
  const grant = await issueDevProviderGrant(provider.fixture.paths, {
    pin: provider.installed.pin, projectRoot: await realpath(root), grantId: "probe-grant",
  });
  return devProviderInvocation({
    paths: provider.fixture.paths, installed: provider.installed, grant,
    backend, safetyFloorVersion: "1.0.0",
  });
}

/** Drive one staged run through the production runner with (or without) the host. */
export function driveSeam(
  staged: StagedPackRunV1,
  legInputFor?: ReturnType<typeof devProviderInvocation>,
): ReturnType<typeof runPreparation> {
  return runPreparation(assembleRunnerInput(staged.action, {
    ...runnerContext(staged),
    ...(legInputFor === undefined ? {} : { providerInvocation: { legInputFor } }),
  }));
}

/**
 * Drive the seam, require the handed-off terminal with the extract phase
 * SUCCEEDED, and return the durable phase output's item titles — the shared
 * happy-path assertion every provider-echo witness ends on.
 */
export async function drivenExtractTitles(
  staged: StagedPackRunV1, legInputFor?: ReturnType<typeof devProviderInvocation>,
): Promise<string[]> {
  const result = await driveSeam(staged, legInputFor);
  expect(result.status, resultReason(result)).toBe("handed-off");
  expect((await phaseStates(staged)).get("extract")).toBe("succeeded");
  const output = await readPhaseOutput(staged, "extract") as { items: Array<{ title: string }> };
  return output.items.map((item) => item.title);
}

/**
 * The leg's own pre-invoke step, reproduced for a direct invocation-seam drive:
 * `providerLegRunner` replaces the host-stubbed `launchParentDir` with a fresh
 * custody directory before calling invoke (the host states the tree path only
 * because the request shape requires one). A witness invoking directly must do
 * the same or it measures a permissions artifact instead of the backend.
 */
export function withFreshLaunchParent<R extends { launch: object }>(
  request: R, launchParentDir: string,
): R {
  return { ...request, launch: { ...request.launch, launchParentDir } };
}

/**
 * Temporary roots this fixture created, so a suite can remove them: each arm
 * seeds a canary and a launch parent OUTSIDE the tracked run root, and without
 * this they accumulate one directory per run.
 */
const scratchRoots: string[] = [];

/** Remove every temporary root this fixture created. */
export async function cleanupSeamScratch(): Promise<void> {
  await Promise.all(scratchRoots.splice(0).map(
    (dir) => rm(dir, { recursive: true, force: true })));
}

/** Seed the out-of-scratch canary file; unchanged content proves confinement. */
export async function seedCanary(): Promise<string> {
  const canaryDir = await mkdtemp(path.join(tmpdir(), "seam-canary-"));
  scratchRoots.push(canaryDir);
  const canary = path.join(canaryDir, "escape");
  await writeFile(canary, "seed", "utf8");
  return canary;
}
