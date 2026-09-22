/**
 * @file test/products/product-service-refusals.test.ts
 * @description What the product service REFUSES, and the one control that gives
 * the end-to-end parity assertion its discriminating power.
 *
 * THE PARITY CASE HAS A RED SIDE HERE. `product-vertical-e2e` asserts that an
 * alias and its canonical action compile to the SAME plan digest; an equality
 * that can never fail proves nothing, so this suite drives an alias pointed at a
 * DIFFERENT action through the same seam and requires the digests to DIFFER.
 * Together they establish that the digest tracks which action was resolved,
 * which is the property WOP-INV-21 needs.
 *
 * NO PRODUCT MODE IS EVER A FALLBACK. A project in legacy mode, and a project
 * whose binding conflicts with a legacy `profile.json`, both REFUSE — a product
 * action never quietly runs against the default profile.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrincipalAuthorityError } from "../../src/preparations/principals.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import {
  activatedProject, buildVerticalProduct, verticalPack, verticalService,
  VERTICAL_ACTION_ID, VERTICAL_ALIAS_TOKEN, VERTICAL_WORKSPACE_ID,
} from "./product-vertical-fixture.js";

const INPUT = { topic: "superconductivity" } as const;

/** Every temp directory this suite created, reclaimed after each case. */
const reclaim: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(reclaim.splice(0).map((cleanup) => cleanup()));
});

/** One activated project registered for cleanup. */
async function project(pack?: WorkspaceOperationsPackV2) {
  const activated = await activatedProject(pack === undefined ? undefined : buildVerticalProduct(pack));
  reclaim.push(() => activated.cleanup());
  return activated;
}

/** A bare project with no product installed at all. */
async function legacyProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "product-legacy-"));
  reclaim.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Write a valid legacy `.llmwiki/profile.json` beside an existing binding. */
async function writeLegacyProfile(root: string): Promise<void> {
  const file = path.join(root, PROFILE_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profileId: "legacy", entities: {} }), "utf8");
}

/** The vertical pack with a SECOND action, and its alias retargeted onto it. */
function retargetedAliasPack(): WorkspaceOperationsPackV2 {
  return verticalPack((pack) => {
    pack.actions["demo.other"] = { ...pack.actions[VERTICAL_ACTION_ID]!, actionId: "demo.other", actionVersion: "2.0.0" };
    pack.aliases = [
      { aliasId: "draft-alias", surface: "sdk", token: VERTICAL_ALIAS_TOKEN, actionId: "demo.other" },
    ];
  });
}

describe("product service refusals", () => {
  it("refuses a project with no active product, never falling back to legacy", async () => {
    const result = await verticalService(await legacyProject()).preview({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
    });
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining("no product is active") });
  });

  it("refuses a project whose binding conflicts with a legacy profile", async () => {
    const activated = await project();
    await writeLegacyProfile(activated.root);
    const result = await verticalService(activated.root).preview({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
    });
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining("neither is authoritative") });
  });

  it("refuses a token the active product exposes on no surface", async () => {
    const activated = await project();
    const result = await verticalService(activated.root).preview({
      workspaceId: VERTICAL_WORKSPACE_ID, token: "not.an.action", input: INPUT,
    });
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining("unknown-token") });
  });

  it("refuses an alias that would inject default inputs", async () => {
    const activated = await project(verticalPack((pack) => {
      pack.aliases = [{
        aliasId: "draft-alias", surface: "sdk", token: VERTICAL_ALIAS_TOKEN,
        actionId: VERTICAL_ACTION_ID, defaultInputs: { topic: "physics" },
      }];
    }));
    const result = await verticalService(activated.root).preview({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, input: INPUT,
    });
    expect(result).toEqual({ status: "refused", reason: expect.stringContaining("alias-default-inputs-deferred") });
  });

  it("refuses an invocation from a principal holding no run grant", async () => {
    const activated = await project();
    // A THROW, not a refusal: authority failures are raised by the preparation
    // service's own principal capture, and this service adds no second check
    // that could answer differently.
    await expect(verticalService(activated.root, []).invoke({
      workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT,
    })).rejects.toBeInstanceOf(PrincipalAuthorityError);
  });

  it("compiles a DIFFERENT plan when the alias names a different action", async () => {
    const activated = await project(retargetedAliasPack());
    const service = verticalService(activated.root);
    const direct = await service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ACTION_ID, input: INPUT });
    const alias = await service.preview({ workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, input: INPUT });
    if (direct.status === "refused" || alias.status === "refused") throw new Error("expected both to compile");
    expect(alias.action.actionId).toBe("demo.other");
    // THE RED SIDE of the end-to-end parity assertion.
    expect(alias.action.planDigest).not.toBe(direct.action.planDigest);
  });
});
