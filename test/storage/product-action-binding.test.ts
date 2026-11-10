/**
 * @file test/storage/product-action-binding.test.ts
 * @description Product action resolution and the workspace-contract review as
 * ONE body each over their steps, `resolveProductActionWith` and
 * `resolveActiveWorkspaceContractWith`, bound through `productActionStepsOver`,
 * with no project directory. This file uses them, which exist only after the
 * resolver was given steps of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. The real vertical product is installed and activated on disk,
 * ONCE: the active resolution, the installed package, the pack and lock member
 * texts and the root forms' answers are taken, then the directory is removed.
 * Memory steps answer from those values and log every call, so both bodies are
 * required to answer exactly as the disk did (the vertical action declares no
 * evidence captures, so its captures hand the input back unchanged), and the
 * refusal ladder, the allowlisted-error catch and the order of reads are pinned.
 * The bound composition and the root forms are shown reaching their readers with
 * exact arguments.
 *
 * NOT SHOWN HERE: the readers and captures themselves, and the compiler; the
 * product binding, package, evidence capture and compiler suites show those.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as manifestAuthority from "../../src/products/binding/manifest-authority.js";
import { ProductBindingError } from "../../src/products/binding/problems.js";
import * as binding from "../../src/products/binding/resolve.js";
import type { ActiveProductResolution, ActiveProductSources } from "../../src/products/binding/resolve.js";
import * as artifactCapture from "../../src/products/artifact-evidence-capture.js";
import * as pageCapture from "../../src/products/page-evidence-capture.js";
import * as sourceCapture from "../../src/products/source-evidence-capture.js";
import {
  productActionStepsOver, resolveActiveWorkspaceContract, resolveActiveWorkspaceContractWith,
  resolveProductAction, resolveProductActionWith, type ProductActionSteps,
} from "../../src/products/action-resolve.js";
import * as packageStore from "../../src/products/packages/store.js";
import type { InstalledPackageRead } from "../../src/products/packages/store.js";
import { activatedProject, VERTICAL_ALIAS_TOKEN, VERTICAL_WORKSPACE_ID } from "../products/product-vertical-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });

const REQUEST = { workspaceId: VERTICAL_WORKSPACE_ID, token: VERTICAL_ALIAS_TOKEN, surface: "sdk", input: { topic: "binding" } } as const;
let ACTIVE: ActiveProductResolution, PACKAGE: InstalledPackageRead, TEXTS: { pack: string; lock: string };
let RESOLVED: unknown, CONTRACT: unknown;

beforeAll(async () => {
  const project = await activatedProject();
  try {
    ACTIVE = await binding.resolveActiveProduct(project.root);
    PACKAGE = await packageStore.readInstalledProductPackage(project.root, project.packageDigest);
    if (PACKAGE.status !== "ok") throw new Error("the minted package did not read back");
    const { manifest } = PACKAGE;
    TEXTS = {
      pack: await manifestAuthority.readStoredMemberText(project.root, manifest.packageDigest, manifest.rootOperationsPack, 1 << 20),
      lock: await manifestAuthority.readStoredMemberText(project.root, manifest.packageDigest, manifest.compositionLock, 1 << 20),
    };
    [RESOLVED, CONTRACT] = [await resolveProductAction(project.root, REQUEST), await resolveActiveWorkspaceContract(project.root)];
  } finally {
    await project.cleanup();
  }
});

/** What the steps answer; anything left out answers as the disk did. */
interface World { active?: ActiveProductResolution; pkg?: InstalledPackageRead; pack?: string | Error; refuse?: "source" | "artifact" | "page" }

/** Memory steps over `world`, each call logged. */
function stepsOf(log: string[], world: World = {}): ProductActionSteps {
  const capture = (kind: "source" | "artifact" | "page") => async (_pack: unknown, actionId: string, input: Readonly<Record<string, unknown>>) => {
    log.push(`${kind} ${actionId}`);
    return (world.refuse === kind ? { refused: `${kind} refused` } : { input }) as never;
  };
  return {
    resolveActive: async () => { log.push("active"); return world.active ?? ACTIVE; },
    readPackage: async () => { log.push("package"); return world.pkg ?? PACKAGE; },
    readMember: async (_digest, member) => {
      const isPack = PACKAGE.status === "ok" && member === PACKAGE.manifest.rootOperationsPack;
      log.push(isPack ? "member pack" : "member lock");
      const text = isPack ? world.pack ?? TEXTS.pack : TEXTS.lock;
      if (text instanceof Error) throw text;
      return text;
    },
    captureSource: capture("source"), captureArtifact: capture("artifact"), capturePage: capture("page"),
  };
}

/** Resolve over `world`: the outcome and the log. */
async function resolveOver(world: World = {}): Promise<[unknown, string[]]> {
  const log: string[] = [];
  return [await resolveProductActionWith(stepsOf(log, world), REQUEST), log];
}

const READS = ["active", "package", "member pack", "member lock"];
const CAPTURES = ["source demo.run", "artifact demo.run", "page demo.run"];

describe("the product resolver's one body over memory steps", () => {
  it("A1 resolves the vertical action exactly as the disk did: active, package, pack, lock, then the three captures in order", async () => {
    expect(RESOLVED).toMatchObject({ status: "resolved" });
    expect(await resolveOver()).toEqual([RESOLVED, [...READS, ...CAPTURES]]);
  });

  it("A2 reviews the workspace contract exactly as the disk did, capturing nothing", async () => {
    const log: string[] = [];
    expect(CONTRACT).toMatchObject({ status: "ok" });
    expect([await resolveActiveWorkspaceContractWith(stepsOf(log)), log]).toEqual([CONTRACT, READS]);
  });

  it("A3 refuses every non-product mode, and an unresolved package, before any member is read", async () => {
    expect(await resolveOver({ active: { mode: "legacy" } })).toEqual([{ status: "refused", reason: expect.stringContaining("no product is active") }, ["active"]]);
    expect(await resolveOver({ active: { mode: "conflict" } })).toEqual([{ status: "refused", reason: expect.stringContaining("neither is authoritative") }, ["active"]]);
    expect(await resolveOver({ active: { mode: "unavailable", detail: "gone" } })).toEqual([{ status: "refused", reason: "the active product is unavailable: gone" }, ["active"]]);
    expect(await resolveOver({ pkg: { status: "absent" } })).toEqual([{ status: "refused", reason: "the installed product package is absent" }, ["active", "package"]]);
  });

  it("A4 an allowlisted pack fault refuses and an unparsable pack refuses before the lock is read; any other fault rethrows", async () => {
    const [bound] = await resolveOver({ pack: new ProductBindingError("member drifted") });
    expect(bound).toEqual({ status: "refused", reason: "the product action could not be compiled: member drifted" });
    const [unparsable, log] = await resolveOver({ pack: "{}" });
    expect([unparsable, log]).toEqual([{ status: "refused", reason: expect.stringContaining("could not be compiled") }, ["active", "package", "member pack"]]);
    const fault = new Error("EIO");
    await expect(resolveProductActionWith(stepsOf([], { pack: fault }), REQUEST)).rejects.toBe(fault);
    await expect(resolveActiveWorkspaceContractWith(stepsOf([], { pack: fault }))).rejects.toBe(fault);
    expect(await resolveActiveWorkspaceContractWith(stepsOf([], { pack: new ProductBindingError("member drifted") })))
      .toEqual({ status: "refused", reason: "the product package could not be read: member drifted" });
  });

  it("A5 the first capture refusal wins, and no later capture runs", async () => {
    expect(await resolveOver({ refuse: "source" })).toEqual([{ status: "refused", reason: "source refused" }, [...READS, CAPTURES[0]]]);
    expect(await resolveOver({ refuse: "artifact" })).toEqual([{ status: "refused", reason: "artifact refused" }, [...READS, ...CAPTURES.slice(0, 2)]]);
    expect(await resolveOver({ refuse: "page" })).toEqual([{ status: "refused", reason: "page refused" }, [...READS, ...CAPTURES]]);
  });
});

describe("the bound composition and the root forms", () => {
  /** Spies on every reader and capture, answering as the disk did. */
  const spiesOn = (forms: "From" | "root") => {
    const input = (calls: unknown[]) => ({ input: calls[3] });
    return forms === "From" ? {
      active: vi.spyOn(binding, "resolveActiveProductFrom").mockResolvedValue(ACTIVE),
      pkg: vi.spyOn(packageStore, "readInstalledProductPackageFrom").mockResolvedValue(PACKAGE),
      member: vi.spyOn(manifestAuthority, "readStoredMemberTextFrom").mockImplementation(async (_r, _d, member) => (member === (PACKAGE as { manifest: { rootOperationsPack: unknown } }).manifest.rootOperationsPack ? TEXTS.pack : TEXTS.lock)),
      source: vi.spyOn(sourceCapture, "captureSourceEvidenceInputFrom").mockImplementation(async (...calls) => input(calls) as never),
      artifact: vi.spyOn(artifactCapture, "captureArtifactEvidenceInputFrom").mockImplementation(async (...calls) => input(calls) as never),
      page: vi.spyOn(pageCapture, "capturePageEvidenceInputFrom").mockImplementation(async (...calls) => input(calls) as never),
    } : {
      active: vi.spyOn(binding, "resolveActiveProduct").mockResolvedValue(ACTIVE),
      pkg: vi.spyOn(packageStore, "readInstalledProductPackage").mockResolvedValue(PACKAGE),
      member: vi.spyOn(manifestAuthority, "readStoredMemberText").mockImplementation(async (_r, _d, member) => (member === (PACKAGE as { manifest: { rootOperationsPack: unknown } }).manifest.rootOperationsPack ? TEXTS.pack : TEXTS.lock)),
      source: vi.spyOn(sourceCapture, "captureSourceEvidenceInput").mockImplementation(async (...calls) => input(calls) as never),
      artifact: vi.spyOn(artifactCapture, "captureArtifactEvidenceInput").mockImplementation(async (...calls) => input(calls) as never),
      page: vi.spyOn(pageCapture, "capturePageEvidenceInput").mockImplementation(async (...calls) => input(calls) as never),
    };
  };
  const firsts = (spies: ReturnType<typeof spiesOn>) => Object.values(spies).map((spy) => spy.mock.calls.map((call: readonly unknown[]) => call[0]));

  it("B1 the composition reaches each lower body over its own seam: product sources, their package reads, source leaves, page reads", async () => {
    const packages = {} as ActiveProductSources["packages"];
    const sources = { product: { packages } as ActiveProductSources, sourceLeaves: {} as never, pages: {} as never };
    const spies = spiesOn("From");
    expect(await resolveProductActionWith(productActionStepsOver(sources), REQUEST)).toEqual(RESOLVED);
    expect(firsts(spies)).toEqual([[sources.product], [packages], [packages, packages], [sources.sourceLeaves], [sources.pages], [sources.pages]]);
  });

  it("B2 the root forms reach every incumbent root reader and capture with the root first", async () => {
    const spies = spiesOn("root");
    expect(await resolveProductAction("/project", REQUEST)).toEqual(RESOLVED);
    expect(await resolveActiveWorkspaceContract("/project")).toEqual(CONTRACT);
    expect(firsts(spies)).toEqual([Array(2).fill("/project"), Array(2).fill("/project"), Array(4).fill("/project"), ["/project"], ["/project"], ["/project"]]);
    expect(spies.pkg.mock.calls[0]?.[1]).toBe((ACTIVE as { binding: { packageDigest: string } }).binding.packageDigest);
  });
});
