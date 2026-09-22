/**
 * @file test/products/product-vertical-e2e.test.ts
 * @description THE end-to-end proof of the WOP V3 product vertical: a real
 * product package is installed (slice 1), activated (slice 2), compiled and
 * driven (slice 3) through the slice-4 product service, over the production
 * seams only.
 *
 * THE ALIAS PARITY ASSERTION IS ON THE PLAN DIGEST, not on "both compiled"
 * (WOP-INV-21). A plan digest is the RFC 8785 digest of the whole normalized
 * plan — authorities, action descriptor, requested surface, capability ceiling,
 * sealed input set and bounds — so two invocations agreeing on it agree on
 * everything the run is sealed against. Mutation witness: change the alias's
 * `actionId` to a second declared action, or its transport surface to one with a
 * different capability ceiling, and `actionAuthority` moves, so the digest moves
 * and this equality goes red. Nothing weaker than the digest would catch either.
 *
 * NOTHING HERE ASSEMBLES A RUNNER INPUT. The service does, through slice 3C's
 * production assembler; this suite only names an action and reads the answer.
 */

import { describe, expect, it } from "vitest";
import { scanOperationInventory } from "../../src/operation-bundles/capacity.js";
import type { OperationMutation } from "../../src/operation-bundles/types.js";
import { createPreparationService } from "../../src/preparations/service.js";
import type {
  CompiledActionSummaryV1, ProductPreviewResultV1,
} from "../../src/products/service.js";
import {
  activatedProject, verticalService,
  VERTICAL_ACTION_ID, VERTICAL_ALIAS_TOKEN, VERTICAL_WORKSPACE_ID,
} from "./product-vertical-fixture.js";

/** The caller input both invocation forms declare, so only the NAME differs. */
const INPUT = { topic: "superconductivity" } as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The compile-time summary a preview settled, or the refusal that stopped it. */
function summaryOf(result: ProductPreviewResultV1): CompiledActionSummaryV1 {
  if (result.status === "refused") throw new Error(`preview refused: ${result.reason}`);
  return result.action;
}

/** Every mutation the ONE bundle a driven project holds actually declares. */
async function handedOffMutations(root: string): Promise<readonly OperationMutation[]> {
  const inventory = await scanOperationInventory(root);
  expect(inventory.problems).toEqual([]);
  expect(inventory.manifests).toHaveLength(1);
  return inventory.manifests[0]!.mutations;
}

/** Every preparation run the project holds, read through the production service. */
async function runCount(root: string): Promise<number> {
  const listed = await createPreparationService({
    root, surface: "sdk", principals: { principalFor: () => ({ id: "reader", surface: "sdk", grants: [] }) },
  }).list();
  expect(listed.problems).toEqual([]);
  return listed.total;
}

describe("WOP V3 product vertical", () => {
  it("compiles a byte-identical plan through an alias and through the action id", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root);
    const direct = await service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT });
    const alias = await service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, input: INPUT });
    expect(alias.status).toBe(direct.status);
    expect(summaryOf(alias).planDigest).toBe(summaryOf(direct).planDigest);
    expect(summaryOf(direct).planDigest).toMatch(DIGEST);
    await project.cleanup();
  });

  it("resolves the alias to the canonical action on the caller's own surface", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root);
    const alias = summaryOf(await service.preview({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, input: INPUT,
    }));
    expect(alias.actionId).toBe(VERTICAL_ACTION_ID);
    expect(alias.route).toBe("alias");
    expect(alias.requestedSurface).toBe("sdk");
    await project.cleanup();
  });

  it("previews without the run grant and without creating a run", async () => {
    const project = await activatedProject();
    // NO GRANTS. Preview is grant-free by delegation: the preparation service
    // charges nothing for `preview`, and this service adds no second authority.
    const service = verticalService(project.root, []);
    await service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT });
    await service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, input: INPUT });
    expect(await runCount(project.root)).toBe(0);
    await project.cleanup();
  });

  it("drives one invocation to a Milestone A handoff bundle", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root, ["preparation.run"]);
    const result = await service.invoke({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
    });
    if (result.status !== "handed-off") throw new Error(`invoke did not hand off: ${JSON.stringify(result)}`);
    expect(result.bundleManifestDigest).toMatch(DIGEST);
    expect(result.action.actionId).toBe(VERTICAL_ACTION_ID);
    expect(await runCount(project.root)).toBe(1);
    await project.cleanup();
  });

  it("hands off a bundle carrying a REAL page-create mutation, not an empty obligation", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root, ["preparation.run"]);
    const result = await service.invoke({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
    });
    expect(result.status).toBe("handed-off");

    // MUTATION WITNESS. The materializer previously emitted `targets: []`, so the
    // manifest compiled to ZERO mutations and this array was empty; every suite
    // was green anyway because nothing read it. Revert the materializer to the
    // empty-target form and this length assertion goes red first.
    const mutations = await handedOffMutations(project.root);
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0]!;
    expect(mutation.kind).toBe("page");
    expect(mutation.operation).toBe("create");
    if (mutation.kind !== "page") throw new Error("mutation is not a page create");
    expect(mutation.target).toEqual({ kind: "entity", entityType: "wiki-page", slug: "action-input" });
    // The honest-sourcing property: the postcondition is the payload's OWN content
    // address, so nothing here is a post-apply digest the run could not observe.
    // A create declares bytes; only a delete declares absence. Narrowing here
    // keeps the assertion about THIS mutation's postcondition rather than the
    // union's shape.
    if ("kind" in mutation.postcondition) throw new Error("page create must declare its bytes");
    expect(mutation.postcondition.digest).toBe(`sha256:${mutation.payloadRef}`);
    expect(mutation.precondition).toEqual({ kind: "absent" });
    expect(mutation.reconciliationRefs).toEqual(["pack-intent-accept"]);
    await project.cleanup();
  });

  it("hands off the same plan whether the caller named the action or the alias", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root, ["preparation.run"]);
    const direct = await service.invoke({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT });
    const alias = await service.invoke({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, input: INPUT });
    expect(direct.status).toBe("handed-off");
    expect(alias.status).toBe("handed-off");
    // Two runs of ONE plan: the digest the alias staged is the digest the direct
    // invocation staged, so the alias drove the identical certified preparation.
    if (direct.status === "refused" || alias.status === "refused") throw new Error("invoke refused");
    expect(alias.action.planDigest).toBe(direct.action.planDigest);
    expect(alias.runId).not.toBe(direct.runId);
    await project.cleanup();
  });

  it("previews as a true dry run once the project holds an integrity key", async () => {
    const project = await activatedProject();
    const service = verticalService(project.root, ["preparation.run"]);
    await service.invoke({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT });
    const previewed = await service.preview({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
    });
    expect(previewed.status).toBe("previewed");
    // The dry run projected a second staging and published none of it.
    expect(await runCount(project.root)).toBe(1);
    await project.cleanup();
  });
});
