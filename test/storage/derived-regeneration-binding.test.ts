/**
 * @file test/storage/derived-regeneration-binding.test.ts
 * @description The two derived-artifact sequencers outside compile as ONE body
 * each over their own root-free steps: the OKF import refresh
 * (`refreshAfterImportWith`, ending in the embedding DRAIN) and source removal's
 * regeneration (`regenerateDerivedWith`, ending in the writer core with its
 * warn-or-strict failure rule); and each one's BOUND COMPOSITION
 * (`importRefreshStepsOver`, `derivedRegenerationStepsOver`) over the lower
 * root-free bodies. This file uses them, which exist only after the two were
 * given steps of their own, so it has NO before-edit run.
 *
 * No body takes a project root: each step is already bound to its project.
 *
 * WHAT IS SHOWN. Each body's decisions: the OKF id-to-slug mapping and order,
 * that a failing step stops the rest with the same error, and removal's
 * embedding-failure meaning (a warning, or a rethrow when strict). The root
 * forms are shown reaching each incumbent with its exact arguments, the
 * incumbents stubbed so no project is written.
 *
 * NOT SHOWN HERE: what the steps themselves do; the link, index, MOC, embedding,
 * OKF import and `rm` suites show those. The lock is the caller's and is not
 * taken here.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as indexgen from "../../src/compiler/indexgen.js";
import * as obsidian from "../../src/compiler/obsidian.js";
import * as resolver from "../../src/compiler/resolver.js";
import { importRefreshStepsOver, refreshAfterImport, refreshAfterImportWith, type ImportRefreshSources, type ImportRefreshSteps } from "../../src/import/okf-refresh.js";
import {
  derivedRegenerationStepsOver, regenerateDerivedLocked, regenerateDerivedWith, type DerivedRegenerationSteps,
} from "../../src/sources/removal.js";
import { ENV_EMBED_STRICT } from "../../src/utils/constants.js";
import * as embeddings from "../../src/utils/embeddings.js";
import * as embeddingsRefresh from "../../src/utils/embeddings-refresh.js";
import * as output from "../../src/utils/output.js";
import type { PageId } from "../../src/utils/page-id.js";

const ROOT = "/memory/project";
const IDS = ["concepts/alpha", "queries/beta"] as PageId[];
afterEach(() => { vi.restoreAllMocks(); restoreEnv(); });

/** The compile tail's steps, each call logged; `fail` names the one step that rejects. */
function importSteps(log: string[], fail?: keyof ImportRefreshSteps): ImportRefreshSteps {
  const step = (name: keyof ImportRefreshSteps) => async (...args: unknown[]) => {
    log.push(`${name} ${JSON.stringify(args)}`);
    if (name === fail) throw new Error(`${name} failed`);
  };
  return { resolveLinks: step("resolveLinks"), generateIndex: step("generateIndex"), generateMOC: step("generateMOC"), refreshEmbeddings: step("refreshEmbeddings") };
}

/** Removal's steps, each call logged; `fail` names the one step that rejects. */
function removalSteps(log: string[], fail?: keyof DerivedRegenerationSteps): DerivedRegenerationSteps {
  const step = (name: keyof DerivedRegenerationSteps) => async (...args: unknown[]) => {
    log.push(`${name} ${JSON.stringify(args)}`);
    if (name === fail) throw new Error(`${name} failed`);
  };
  return { generateIndex: step("generateIndex"), generateMOC: step("generateMOC"), updateEmbeddings: step("updateEmbeddings") };
}

describe("the OKF import refresh over the compile tail's steps", () => {
  it("D1 resolves links over the imported slugs, then index, MOC and the embedding drain over the page ids", async () => {
    const log: string[] = [];
    await refreshAfterImportWith(importSteps(log), IDS);
    expect(log).toEqual([
      `resolveLinks ${JSON.stringify([["alpha", "beta"], ["alpha", "beta"]])}`, "generateIndex []",
      "generateMOC []", `refreshEmbeddings ${JSON.stringify([IDS])}`,
    ]);
  });

  it("D2 a failing step rejects with its own error and stops every later step", async () => {
    const log: string[] = [];
    await expect(refreshAfterImportWith(importSteps(log, "generateMOC"), IDS)).rejects.toThrow("generateMOC failed");
    expect(log.map((call) => call.split(" ")[0])).toEqual(["resolveLinks", "generateIndex", "generateMOC"]);
  });
});

describe("source removal's regeneration over its steps", () => {
  it("R1 regenerates index, MOC, then embeddings with no changed pages of its own; an embedding failure only warns", async () => {
    const warned: string[] = [];
    vi.spyOn(output, "status").mockImplementation((_icon, message) => { warned.push(message); });
    const log: string[] = [];
    await regenerateDerivedWith(removalSteps(log, "updateEmbeddings"));
    expect(log).toEqual(["generateIndex []", "generateMOC []", "updateEmbeddings [[]]"]);
    expect(warned.some((message) => message.includes("Skipped embeddings update: updateEmbeddings failed"))).toBe(true);
  });

  it("R2 rethrows the embedding failure when strict, and an index failure stops the MOC and embeddings", async () => {
    vi.spyOn(output, "status").mockImplementation(() => {});
    stubEnv(ENV_EMBED_STRICT, "1");
    await expect(regenerateDerivedWith(removalSteps([], "updateEmbeddings"))).rejects.toThrow("updateEmbeddings failed");
    const log: string[] = [];
    await expect(regenerateDerivedWith(removalSteps(log, "generateIndex"))).rejects.toThrow("generateIndex failed");
    expect(log.map((call) => call.split(" ")[0])).toEqual(["generateIndex"]);
  });
});

describe("each bound composition runs the lower root-free bodies over its own seams", () => {
  it("O1 the import composition resolves over its reads, applies through the caller's applier, and drains", async () => {
    const writes = [{ slug: "alpha" }] as never;
    const lower = {
      links: vi.spyOn(resolver, "resolveLinksFrom").mockResolvedValue(writes),
      index: vi.spyOn(indexgen, "generateIndexFrom").mockResolvedValue(undefined),
      moc: vi.spyOn(obsidian, "generateMOCFrom").mockResolvedValue(undefined),
      drain: vi.spyOn(embeddingsRefresh, "refreshEmbeddingsFrom").mockResolvedValue(true),
    };
    const applied: unknown[] = [];
    const sources = { linkReads: {}, index: {}, moc: {}, embeddings: {}, applyPageWrites: async (given: unknown) => { applied.push(given); } } as unknown as ImportRefreshSources;
    await refreshAfterImportWith(importRefreshStepsOver(sources), IDS);
    expect([lower.links.mock.calls, applied, lower.index.mock.calls, lower.moc.mock.calls, lower.drain.mock.calls]).toEqual([
      [[sources.linkReads, ["alpha", "beta"], ["alpha", "beta"]]], [writes], [[sources.index]], [[sources.moc]], [[sources.embeddings, IDS, "drain"]],
    ]);
  });

  it("O2 the removal composition runs index, MOC and the writer core over its own sources, with no changed pages", async () => {
    const lower = {
      index: vi.spyOn(indexgen, "generateIndexFrom").mockResolvedValue(undefined),
      moc: vi.spyOn(obsidian, "generateMOCFrom").mockResolvedValue(undefined),
      core: vi.spyOn(embeddings, "updateEmbeddingsLockedCoreFrom").mockResolvedValue(undefined as never),
    };
    const sources = { index: {}, moc: {}, embeddings: {} } as unknown as Parameters<typeof derivedRegenerationStepsOver>[0];
    await regenerateDerivedWith(derivedRegenerationStepsOver(sources));
    expect([lower.index.mock.calls, lower.moc.mock.calls, lower.core.mock.calls]).toEqual([[[sources.index]], [[sources.moc]], [[sources.embeddings, []]]]);
  });
});

describe("the root forms reach the incumbents", () => {
  it("Z1 the bodies over steps reach no incumbent, while each root form reaches its own with exact arguments", async () => {
    const spies = {
      links: vi.spyOn(resolver, "resolveAndApplyLinks").mockResolvedValue([]),
      index: vi.spyOn(indexgen, "generateIndex").mockResolvedValue(undefined),
      moc: vi.spyOn(obsidian, "generateMOC").mockResolvedValue(undefined),
      drain: vi.spyOn(embeddingsRefresh, "refreshEmbeddingsDrainingPending").mockResolvedValue(undefined),
      core: vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue(undefined as never),
    };
    await refreshAfterImportWith(importSteps([]), IDS);
    await regenerateDerivedWith(removalSteps([]));
    expect(Object.values(spies).map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    await refreshAfterImport(ROOT, IDS);
    await regenerateDerivedLocked(ROOT);
    expect([spies.links.mock.calls, spies.index.mock.calls, spies.moc.mock.calls, spies.drain.mock.calls, spies.core.mock.calls]).toEqual([
      [[ROOT, ["alpha", "beta"], ["alpha", "beta"]]], [[ROOT], [ROOT]], [[ROOT], [ROOT]], [[ROOT, IDS]], [[ROOT, []]],
    ]);
  });
});
