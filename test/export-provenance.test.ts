/**
 * Unit tests for the W4 export provenance stamp.
 *
 * Verifies the auditable lineage fields a downstream consumer (Atomic Radar)
 * relies on:
 *
 *  - Envelope carries `modelId` (resolved from LLM client config, or an
 *    explicit override) and `promptVersion` (the named prompt-contract const).
 *  - Each page carries a deterministic `contentHash` over its body and the
 *    `sourceHashes` it derived from (surfaced from `.llmwiki/state.json`).
 *  - `contentHash` is stable for the same body and changes when the body does.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { writePage } from "./fixtures/write-page.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { collectExportPages } from "../src/export/collect.js";
import { buildJsonExport } from "../src/export/json-export.js";
import { PROMPT_VERSION } from "../src/compiler/prompts.js";

interface ProvenancePage {
  slug: string;
  body: string;
  contentHash: string;
  sourceHashes: string[];
}

interface ProvenanceEnvelope {
  modelId: string;
  promptVersion: string;
  pages: ProvenancePage[];
}

const STUB_MODEL_ID = "stub-model-1";

/** Hex SHA-256 of a string — mirror of the export's body hash for assertions. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Write a `.llmwiki/state.json` mapping source filenames to fixed hashes. */
async function writeState(root: string, sources: Record<string, string>): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  const state = {
    version: 1,
    indexHash: "",
    sources: Object.fromEntries(
      Object.entries(sources).map(([file, hash]) => [
        file,
        { hash, concepts: [], compiledAt: "2024-01-01T00:00:00.000Z" },
      ]),
    ),
  };
  await writeFile(path.join(root, ".llmwiki/state.json"), JSON.stringify(state), "utf-8");
}

function findPage(env: ProvenanceEnvelope, slug: string): ProvenancePage {
  const page = env.pages.find((p) => p.slug === slug);
  if (!page) throw new Error(`expected page "${slug}" in export`);
  return page;
}

describe("export provenance — envelope modelId + promptVersion", () => {
  it("stamps an explicit modelId override and the named promptVersion", async () => {
    const root = await makeTempRoot("prov-env");
    await writePage(
      path.join(root, "wiki/concepts"),
      "retrieval",
      { title: "Retrieval", summary: "x", sources: [] },
      "Body.\n",
    );
    const pages = await collectExportPages(root);
    const env = JSON.parse(
      buildJsonExport(pages, { modelId: STUB_MODEL_ID }),
    ) as ProvenanceEnvelope;

    expect(env.modelId).toBe(STUB_MODEL_ID);
    expect(env.promptVersion).toBe(PROMPT_VERSION);
  });

  it("resolves modelId from LLMWIKI_MODEL when no override is given", async () => {
    const root = await makeTempRoot("prov-modelenv");
    await writePage(
      path.join(root, "wiki/concepts"),
      "p",
      { title: "P", summary: "s", sources: [] },
      "Body.\n",
    );
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.LLMWIKI_MODEL = "claude-test-model";
    try {
      const env = JSON.parse(
        buildJsonExport(await collectExportPages(root)),
      ) as ProvenanceEnvelope;
      expect(env.modelId).toBe("claude-test-model");
    } finally {
      delete process.env.LLMWIKI_PROVIDER;
      delete process.env.LLMWIKI_MODEL;
    }
  });
});

describe("export provenance — per-page contentHash + sourceHashes", () => {
  it("emits a deterministic body hash and resolves source hashes from state", async () => {
    const root = await makeTempRoot("prov-page");
    const body = "Retrieval is selective lookup.";
    await writeState(root, { "paper.md": "a".repeat(64), "other.md": "b".repeat(64) });
    await writePage(
      path.join(root, "wiki/concepts"),
      "retrieval",
      { title: "Retrieval", summary: "x", sources: ["paper.md", "other.md"] },
      body,
    );
    const env = JSON.parse(
      buildJsonExport(await collectExportPages(root), { modelId: STUB_MODEL_ID }),
    ) as ProvenanceEnvelope;
    const page = findPage(env, "retrieval");

    expect(page.contentHash).toBe(sha256(page.body));
    expect(page.sourceHashes).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("keeps contentHash stable for the same body across builds", async () => {
    const root = await makeTempRoot("prov-stable");
    await writePage(
      path.join(root, "wiki/concepts"),
      "stable",
      { title: "Stable", summary: "s", sources: [] },
      "Identical body content.\n",
    );
    const first = JSON.parse(
      buildJsonExport(await collectExportPages(root), { modelId: STUB_MODEL_ID }),
    ) as ProvenanceEnvelope;
    const second = JSON.parse(
      buildJsonExport(await collectExportPages(root), { modelId: STUB_MODEL_ID }),
    ) as ProvenanceEnvelope;

    expect(findPage(first, "stable").contentHash).toBe(findPage(second, "stable").contentHash);
  });

  it("omits unrecorded sources from sourceHashes (empty when none recorded)", async () => {
    const root = await makeTempRoot("prov-nosrc");
    await writePage(
      path.join(root, "wiki/concepts"),
      "seedlike",
      { title: "Seedlike", summary: "s", sources: [] },
      "Body.\n",
    );
    const env = JSON.parse(
      buildJsonExport(await collectExportPages(root), { modelId: STUB_MODEL_ID }),
    ) as ProvenanceEnvelope;
    expect(findPage(env, "seedlike").sourceHashes).toEqual([]);
  });
});
