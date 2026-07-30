/**
 * @file test/compile-source-deletion-reconciliation.test.ts
 * @description End-to-end regression coverage for rebuilding a shared concept
 * from its surviving owners after one contributing source is deleted.
 */

import { describe, expect, it, vi } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileAndReport } from "../src/compiler/index.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { buildFrontmatter, parseFrontmatter } from "../src/utils/markdown.js";
import { readState, writeState } from "../src/utils/state.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";

const EXTRACTION = JSON.stringify({
  concepts: [{ concept: "Shared Topic", summary: "Shared summary.", is_new: true }],
});

const ctx = useCompileProject({
  dirSuffix: "delete-reconcile",
  sourceFile: "a.md",
  sourceContent: "# Shared Topic\n\nA-only deleted contribution.",
});

interface ReconciliationProbe {
  extractionSystems: string[];
  pageSystems: string[];
  markDeleted: () => void;
  markSurvivorFailure: () => void;
}

/** Seed the surviving source and capture both LLM phases across two compiles. */
async function arrangeReconciliation(): Promise<ReconciliationProbe> {
  await writeFile(
    path.join(ctx.dir, "sources", "b.md"),
    "# Shared Topic\n\nB-only surviving contribution.",
    "utf-8",
  );
  let phase: "initial" | "deleted" | "failed" = "initial";
  const extractionSystems: string[] = [];
  const pageSystems: string[] = [];
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(async (system) => {
    extractionSystems.push(system);
    return phase === "failed" ? JSON.stringify({ concepts: [] }) : EXTRACTION;
  });
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(async (system) => {
    pageSystems.push(system);
    return phase === "initial"
      ? "Old claim from deleted contributor. ^[a.md:1-2]\n\nShared claim. ^[b.md:1-2]"
      : "Rebuilt survivor claim. ^[b.md:1-2, a.md:1-2]";
  });
  vi.spyOn(embeddings, "updateEmbeddingsLockedCore")
    .mockResolvedValue({ embedded: [], eligible: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    extractionSystems,
    pageSystems,
    markDeleted: () => { phase = "deleted"; },
    markSurvivorFailure: () => { phase = "failed"; },
  };
}

/** Read the shared page and incremental state after one compile. */
async function readSharedArtifacts() {
  const page = parseFrontmatter(
    await readFile(path.join(ctx.dir, "wiki", "concepts", "shared-topic.md"), "utf-8"),
  );
  return { page, state: await readState(ctx.dir) };
}

describe("shared-source deletion reconciliation", () => {
  it("rebuilds from the surviving owner and clears deleted provenance", async () => {
    const probe = await arrangeReconciliation();

    await compileAndReport(ctx.dir);
    probe.markDeleted();
    probe.extractionSystems.length = 0;
    probe.pageSystems.length = 0;
    await rm(path.join(ctx.dir, "sources", "a.md"));
    const result = await compileAndReport(ctx.dir);

    const { page, state } = await readSharedArtifacts();
    expect(result).toMatchObject({ compiled: 1, deleted: 1, pages: ["shared-topic"] });
    expect(probe.extractionSystems).toHaveLength(1);
    expect(probe.extractionSystems[0]).toContain("B-only surviving contribution.");
    expect(probe.pageSystems[0]).not.toContain("Old claim from deleted contributor.");
    expect(page.meta.sources).toEqual(["b.md"]);
    expect(page.body).toContain("^[b.md:1-2]");
    expect(page.body).not.toContain("a.md");
    expect(state.sources["a.md"]).toBeUndefined();
  });

  it("orphans an ownerless persisted frozen page without source changes", async () => {
    await arrangeReconciliation();
    await compileAndReport(ctx.dir);
    const state = await readState(ctx.dir);
    state.frozenSlugs = ["ownerless"];
    await writeState(ctx.dir, state);
    const frontmatter = buildFrontmatter({
      title: "Ownerless",
      summary: "No source owns this page.",
      sources: [],
    });
    await writeFile(
      path.join(ctx.dir, "wiki", "concepts", "ownerless.md"),
      `${frontmatter}\n\nStale content.\n`,
      "utf-8",
    );

    await compileAndReport(ctx.dir);

    const page = parseFrontmatter(
      await readFile(path.join(ctx.dir, "wiki", "concepts", "ownerless.md"), "utf-8"),
    );
    const reconciled = await readState(ctx.dir);
    expect(page.meta.orphaned).toBe(true);
    expect(reconciled.frozenSlugs).toEqual([]);
  });

  it("keeps a retryable last-known-good page when survivor extraction fails", async () => {
    const probe = await arrangeReconciliation();
    await compileAndReport(ctx.dir);
    probe.markSurvivorFailure();
    await rm(path.join(ctx.dir, "sources", "a.md"));

    const result = await compileAndReport(ctx.dir);

    const { page, state } = await readSharedArtifacts();
    expect(page.meta.orphaned).not.toBe(true);
    expect(page.meta.sources).toEqual(["a.md", "b.md"]);
    expect(state.sources["a.md"]).toBeUndefined();
    expect(state.sources["b.md"].hash).toBe("");
    expect(state.frozenSlugs).toContain("shared-topic");
    expect(result.errors).toContain("No concepts extracted from b.md");
  });
});
