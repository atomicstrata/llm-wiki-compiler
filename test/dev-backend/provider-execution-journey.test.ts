/**
 * @file test/dev-backend/provider-execution-journey.test.ts
 * @description A REAL provider process executing inside a real pack run: the
 * whole §4.4 chain, with nothing stubbed.
 *
 * EVERY LINK IS THE PRODUCTION ONE. The provider is installed through the
 * platform's local-development install and approved for execution; its pin is
 * the one the resolver resolves; its grant is written by the platform's sole
 * grant transaction; the invocation is assembled by the host adapter; the
 * process is launched by the development backend; and the answer travels back
 * through the runtime's own protocol session, custody, and evidence store into
 * a proposed page. No part of that path is a test double.
 *
 * THIS IS WHAT EVERY EARLIER SLICE WAS SHORT OF. The pack-level journey stubbed
 * the invocation because launching a provider was impossible; the backend tests
 * launched processes but spoke no protocol. Only this file proves the adapter's
 * request actually satisfies the runtime — a request that merely typechecked
 * would fail here on identity, exposure, or grant drift.
 */

import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreparation } from "../../src/index.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { assembleRunnerInput } from "../../src/operations-packs/runtime/runner-input.js";
import type { PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";
import {
  devProviderInvocation, installDevProvider, issueDevProviderGrant, unsandboxedLocalBackend,
} from "../../packages/llmwiki-dev-backend/src/index.js";
import { providerDistribution } from "../fixtures/capability-provider-package.js";
import {
  installResolutionFixture, removeResolutionFixture, type ResolutionFixture,
} from "../capability-providers/resolution-fixture.js";
import { providerIngestRecipe, requestWithRecipe } from "../operations-packs/compile-fixture.js";
import {
  phaseStates, readPhaseOutput, resultReason, runnerContext, stageCompiledAction, stagedRunTracker,
} from "../operations-packs/runtime-fixture.js";
import { echoProviderSource } from "./echo-provider.js";

const runs = stagedRunTracker();
let fixture: ResolutionFixture | undefined;
afterEach(async () => {
  await runs.cleanupAll();
  if (fixture) await removeResolutionFixture(fixture);
  fixture = undefined;
});



/** Write the echo provider's tree and build its matching package payload. */
async function providerMaterial() {
  const source = echoProviderSource();
  const sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "dev-provider-src-")));
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "bin", "provider"), source, "utf8");
  // The payload's digests are computed from these EXACT bytes, so the installer's
  // tree verification passes only because the declaration matches what is here.
  return {
    sourceRoot,
    payload: providerDistribution({ "package/bin/provider": source }, [{
      outputId: "extraction", required: true, mediaTypes: ["application/json"],
      maximumFiles: 1, maximumBytes: 65_536,
    }]).payload,
  };
}


/** Install, approve, grant, compile against the REAL pin, and drive. */
async function runIngest(topic: string, grantForeignProject = false) {
  fixture = await installResolutionFixture();
  const { sourceRoot, payload } = await providerMaterial();
  const installed = await installDevProvider(fixture.paths, {
    sourceRoot, payload, approveExecution: true,
  });

  // The pack declares the pin of the provider that was ACTUALLY installed —
  // the configuration step a shipped product performs at authoring time.
  const base = { ...requestWithRecipe(providerIngestRecipe()), input: { topic } };
  const action = await compilePackAction({
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

  const staged = runs.add(await stageCompiledAction(action));
  // GRANTED FOR THE PROJECT THE RUN IS ACTUALLY IN. An earlier version granted
  // one directory and staged in another, and passed — because the invocation
  // copied the grant's own project digest instead of deriving it from the run.
  const grantedProject = grantForeignProject
    ? await realpath(await mkdtemp(path.join(tmpdir(), "other-project-")))
    : await realpath(staged.root);
  const grant = await issueDevProviderGrant(fixture.paths, {
    pin: installed.pin, projectRoot: grantedProject, grantId: "ingest-grant",
  });
  const result = await runPreparation(assembleRunnerInput(action, {
    ...runnerContext(staged),
    providerInvocation: {
      legInputFor: devProviderInvocation({
        paths: fixture.paths, installed, grant, backend: unsandboxedLocalBackend(),
        safetyFloorVersion: "1.0.0",
      }),
    },
  }));
  return { staged, result };
}

describe("§4.4 a real provider process produces the proposed pages", () => {
  it("sends the SEALED request and proposes a page derived from the provider's answer", async () => {
    const { staged, result } = await runIngest("superconductivity");
    expect(result.status, resultReason(result)).toBe("handed-off");
    expect((await phaseStates(staged)).get("extract")).toBe("succeeded");

    const published = await readPhaseOutput(staged, "propose") as { drafts: Record<string, unknown>[] };
    // "concept of superconductivity" can only exist if the RENDERED REQUEST —
    // carrying the operator's own topic — reached the provider process, which
    // built this string from it. A provider returning canned data, or one sent
    // an empty request, produces a different title.
    expect(published.drafts.map((draft) => (draft.fields as Record<string, unknown>).title))
      .toEqual(["concept of superconductivity"]);
  }, 60_000);

  it("REFUSES a grant issued for a DIFFERENT project", async () => {
    // The property a project-bound grant exists for. It only holds because the
    // invocation derives the project from the RUN: copying the grant's own
    // digest would compare a value against itself and admit anything.
    const { staged, result } = await runIngest("superconductivity", true);
    expect(result.status).not.toBe("handed-off");
    expect((await phaseStates(staged)).get("extract")).not.toBe("succeeded");
  }, 60_000);
});
