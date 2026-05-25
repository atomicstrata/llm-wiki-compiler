/**
 * Regression tests for the final context-pack audit pass.
 *
 * Keeps the high-risk contract fixes out of the already-large context
 * test files: post-budget graph-neighbor cleanup, same-kind graph
 * scoring, and context-specific suggested-action suffixes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { buildContextPack } from "../src/context/build.js";
import { expandGraphNeighborhood } from "../src/context/graph.js";
import { retrieveSemanticChunks } from "../src/context/retrieval.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import type { GraphData, PageId, ViewerPage } from "../src/viewer/types.js";

vi.mock("../src/context/retrieval.js", () => ({
  retrieveSemanticChunks: vi.fn(async () => ({ hits: [], warning: null })),
}));

const mockedRetrieve = vi.mocked(retrieveSemanticChunks);

let root: string;

beforeEach(async () => {
  mockedRetrieve.mockReset();
  mockedRetrieve.mockResolvedValue({ hits: [], warning: null });
  root = await mkdtemp(path.join(os.tmpdir(), "context-audit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConcept(slug: string, title: string, body = ""): Promise<void> {
  const dir = path.join(root, CONCEPTS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${slug}.md`), `---\ntitle: ${title}\n---\n\n${body}\n`);
}

function page(id: PageId, kind: string): ViewerPage {
  const slug = id.split("/")[1] ?? id;
  return {
    id,
    slug,
    pageDirectory: "concepts",
    title: slug,
    filePath: `/tmp/${slug}.md`,
    frontmatter: { kind },
    body: "",
    outgoingLinks: [],
    citations: [],
    warnings: [],
  };
}

function graph(edges: [PageId, PageId][]): GraphData {
  const ids = Array.from(new Set(edges.flat()));
  return {
    nodes: ids.map((id) => ({
      id,
      title: id,
      slug: id.split("/")[1] ?? id,
      directory: "concepts",
      kind: "concept",
      degree: 0,
    })),
    edges: edges.map(([source, target]) => ({ source, target })),
  };
}

describe("context-pack audit regressions", () => {
  it("removes graph-neighbor when budget trimming drops the connected primary peer", async () => {
    await writeConcept("alpha", "Alpha Beta", "[[Alpha Beta Two]]\n\nAlpha beta.");
    await writeConcept("alpha-beta-two", "Alpha Beta Two", "Alpha beta two.");
    const pack = await buildContextPack({
      root,
      prompt: "alpha beta",
      budget: 260,
      topPages: 2,
      topChunks: 0,
    });
    expect(pack.primary).toHaveLength(1);
    expect(pack.budget.trimmedSections).toContain("primary");
    expect(pack.primary[0].reasons).not.toContain("graph-neighbor");
  });

  it("adds the compile action when pages exist but semantic retrieval has no usable store", async () => {
    await writeConcept("alpha", "Alpha", "body");
    mockedRetrieve.mockResolvedValueOnce({ hits: [], warning: "embedding-store-missing" });
    const pack = await buildContextPack({ root, prompt: "alpha" });
    expect(pack.suggestedActions.map((a) => a.command)).toContain("llmwiki compile");
  });

  it("surfaces unexpected semantic retrieval failures as their own warning code", async () => {
    await writeConcept("alpha", "Alpha", "body");
    mockedRetrieve.mockResolvedValueOnce({ hits: [], warning: "semantic-retrieval-error" });
    const pack = await buildContextPack({ root, prompt: "alpha" });
    expect(pack.warnings.map((w) => w.code)).toContain("semantic-retrieval-error");
  });

  it("same-kind graph neighbors receive a small score bonus", () => {
    const out = expandGraphNeighborhood({
      graph: graph([
        ["concepts/primary", "concepts/same"],
        ["concepts/primary", "concepts/other"],
      ]),
      pages: [
        page("concepts/primary", "entity"),
        page("concepts/same", "entity"),
        page("concepts/other", "comparison"),
      ],
      primaryIds: new Set<PageId>(["concepts/primary"]),
      depth: 1,
    });
    const same = out.neighbors.find((n) => n.to === "concepts/same");
    const other = out.neighbors.find((n) => n.to === "concepts/other");
    expect(same?.score).toBeGreaterThan(other?.score ?? 0);
  });
});
