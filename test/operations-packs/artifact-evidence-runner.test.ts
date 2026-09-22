/**
 * @file test/operations-packs/artifact-evidence-runner.test.ts
 * @description W2 through the PRODUCTION runner: a generic pack action whose
 * provider phase seals an artifactEvidenceDescriptor is staged and driven at
 * the standard seam; the MEMBER-ECHO provider reads its materialized inputs
 * mount and reports each member's name and the sha256 of the BYTES IT
 * RECEIVED — so the durable phase output proves the verified member bytes
 * (binary included) actually reached the provider under the sealed
 * inputId→name table. The refusal arm: a run sealed with a FORGED digest
 * column PARKS at the AUTHORITY SEAL with the named reason
 * `authority-artifact-evidence-manifest-drift` — before any phase instance
 * exists, let alone a provider launch — asserted off the runner's own result
 * and the run's empty phase record.
 */

import { describe, expect, it, afterEach } from "vitest";
import {
  devProviderInvocation, issueDevProviderGrant, unsandboxedLocalBackend,
} from "../../packages/llmwiki-dev-backend/src/index.js";
import { devGrantScope, devSourceReadAuthority } from "../../src/capability-providers/host/grant.js";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";
import { installResolutionFixture, type ResolutionFixture } from "../capability-providers/resolution-fixture.js";
import { installProviderFromSource } from "../capability-providers/source-install-fixture.js";
import { removeProviderFixtureRoot } from "../fixtures/capability-provider-package.js";
import { providerIngestRecipe, requestWithRecipe } from "./compile-fixture.js";
import { stageActionIn, type StagedPackRunV1 } from "./runtime-fixture.js";
import { driveSeam, drivenExtractTitles } from "../limited-isolation/seam-fixture.js";
import { makeMembersRoot, writeBundle, twoMembers, shaOf, BINARY_BYTES } from "../fixtures/member-artifact-root.js";
import {
  EVIDENCE_DESCRIPTOR, forgeSecondDigest, sealedBundleValue,
} from "../fixtures/artifact-evidence-fixture.js";
import type { ArtifactRef } from "../../src/artifacts/ref.js";
import type { PackRecipeV2 } from "../../src/operations-packs/recipe-types.js";


/** The echo provider: reports each member's NAME and the sha256 of the bytes it RECEIVED. */
function memberEchoProviderSource(): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
let buffered = Buffer.alloc(0);
let outbound = 0;
let tokens = [];
function send(body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  process.stdout.write(Buffer.concat([prefix, payload]));
}
function handle(frame) {
  if (frame.type === "initialize") {
    tokens = (frame.input && frame.input.inputTokens) || frame.inputTokens || [];
    send({
      protocolVersion: frame.protocolVersion, invocationId: frame.invocationId,
      requestId: "provider-" + outbound, sequence: outbound++, type: "initialized",
      selectedProtocolVersion: frame.protocolVersion, echoedIdentity: frame.expectedIdentity,
      nonce: frame.nonce, declaredCapabilityId: frame.expectedIdentity.capabilityId,
    });
    return;
  }
  if (frame.type === "invoke") {
    const table = (frame.input && frame.input["members"]) || {};
    const items = tokens.map((descriptor) => {
      const bytes = fs.readFileSync(path.join("..", "inputs", descriptor.token));
      const name = String(table[descriptor.inputId] || descriptor.inputId);
      return { itemId: descriptor.inputId, title: name + "=" + crypto.createHash("sha256").update(bytes).digest("hex"), definition: "member echo" };
    });
    const body = Buffer.from(JSON.stringify({ items }), "utf8");
    fs.writeFileSync(path.join(process.env.LLMWIKI_PROVIDER_OUTPUT_ROOT, "extraction"), body);
    send({
      protocolVersion: frame.protocolVersion, invocationId: frame.invocationId,
      requestId: "provider-" + outbound, sequence: outbound++, type: "result",
      result: { outcome: "succeeded", artifactClaims: [{
        outputId: "extraction", outputToken: "extraction",
        claimedDigest: "sha256:" + crypto.createHash("sha256").update(body).digest("hex"), claimedByteCount: body.length,
      }] },
    });
    process.stdout.end();
  }
}
process.stdin.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  for (;;) {
    if (buffered.length < 4) return;
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) return;
    const body = buffered.subarray(4, 4 + length);
    buffered = buffered.subarray(4 + length);
    handle(JSON.parse(body.toString("utf8")));
  }
});
`;
}

/** The ingest recipe with the artifact-evidence descriptor sealed on its provider phase. */
function recipeWithDescriptor(): PackRecipeV2 {
  const recipe = providerIngestRecipe();
  const provider = recipe.phases.find((phase) => phase.kind === "provider")!;
  (provider.body as unknown as Record<string, unknown>).artifactEvidenceDescriptor = EVIDENCE_DESCRIPTOR;
  return recipe;
}

/** The runner's action input: the sealed bundle columns plus the pack's own topic field. */
function sealedValue(ref: ArtifactRef): Record<string, unknown> {
  return { topic: "superconductivity", ...sealedBundleValue(ref) };
}

let fixture: ResolutionFixture | undefined;
const runs: StagedPackRunV1[] = [];
afterEach(async () => {
  delete process.env.LLMWIKI_TRUSTED_WRITE;
  await Promise.all(runs.splice(0).map((run) => run.cleanup()));
  if (fixture !== undefined) await removeProviderFixtureRoot(fixture.root);
  fixture = undefined;
});

/** Install the echo provider, compile the descriptor-carrying action over `input`, stage it IN the members root. */
async function stagedIn(root: string, input: Record<string, unknown>): Promise<{ staged: StagedPackRunV1; legInputFor: ReturnType<typeof devProviderInvocation> }> {
  fixture = await installResolutionFixture();
  const installed = await installProviderFromSource(fixture.paths, memberEchoProviderSource(), "member-echo-");
  const base = { ...requestWithRecipe(recipeWithDescriptor()), input };
  const stringList = { kind: "string-list", required: true, overridable: true, sensitivityDisplay: "normal", maxItems: 8, maxItemBytes: 256 };
  const compiled = await compilePackAction({
    ...base,
    pack: {
      ...base.pack,
      actions: {
        ...base.pack.actions,
        "demo.run": {
          ...base.pack.actions["demo.run"]!,
          inputSchema: {
            ...(base.pack.actions["demo.run"] as { inputSchema: Record<string, unknown> }).inputSchema,
            "bundle-ref": { kind: "string", required: true, overridable: true, sensitivityDisplay: "normal", maxBytes: 512 },
            "member-names": stringList, "member-digests": stringList, "member-byte-counts": stringList,
          },
        },
      },
      providerRequirements: [{
        roleId: "primary-model", disposition: "required",
        capabilityId: String(installed.pin.capabilityId),
        capabilityContractDigest: String(installed.pin.capabilitySchemaDigest),
        allowedProviderPins: [installed.providerPinDigest],
        defaultProviderPin: installed.providerPinDigest,
        requiredReadinessDimensions: [], requestedGrantKinds: ["source-read"],
        fallbackPolicy: { kind: "refuse" },
        requestedBounds: {
          maxBrokerRequestsPerAttempt: 0, maxTokensPerAttempt: 4096,
          maxCostMicrosPerAttempt: 25_000, maxWallTimeMsPerAttempt: 30_000,
        },
      }],
    },
  } as never);
  const staged = await stageActionIn(root, compiled);
  runs.push(staged);
  const grant = await issueDevProviderGrant(fixture.paths, {
    pin: installed.pin, projectRoot: root, grantId: "aev-grant",
    scope: devGrantScope([devSourceReadAuthority("artifact-evidence")]),
  });
  const legInputFor = devProviderInvocation({
    paths: fixture.paths, installed, grant,
    backend: unsandboxedLocalBackend(), safetyFloorVersion: "1.0.0",
  });
  return { staged, legInputFor };
}

describe("artifact evidence through the production runner", () => {
  it("the provider RECEIVES the verified member bytes under the sealed table — proven on the durable record", async () => {
    const root = await makeMembersRoot("aev-run-happy");
    const ref = await writeBundle(root, twoMembers());
    const { staged, legInputFor } = await stagedIn(root, sealedValue(ref));
    expect(await drivenExtractTitles(staged, legInputFor)).toEqual([
      `figure.bin=${shaOf(BINARY_BYTES)}`,
      `main.tex=${shaOf(Buffer.from("\\documentclass{article}", "utf8"))}`,
    ]);
  }, 120_000);

  it("a FORGED sealed digest column PARKS the run at the authority seal — nothing ever executes", async () => {
    const root = await makeMembersRoot("aev-run-drift");
    const ref = await writeBundle(root, twoMembers());
    const sealed = sealedValue(ref);
    const forged = forgeSecondDigest(sealed);
    const { staged, legInputFor } = await stagedIn(root, forged);
    const result = await driveSeam(staged, legInputFor);
    // The refusal fires at the AUTHORITY SEAL — before any phase instance
    // exists, let alone a provider launch: the run PARKS with the named reason.
    expect(result).toMatchObject({ status: "parked", reason: "authority-artifact-evidence-manifest-drift" });
    const read = await readPreparationRun(staged.root, staged.binding);
    if (read.status !== "ok") throw new Error(`run ${read.status}`);
    expect(read.run.phaseSummaries).toEqual([]); // nothing ran over unapproved expectations
  }, 120_000);
});
