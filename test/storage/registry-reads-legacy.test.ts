/**
 * @file test/storage/registry-reads-legacy.test.ts
 * @description The live page registry on real files in a temp directory, for
 * five outcomes the existing registry tests do not state. The file says what
 * giving the registry's loaders and listings a read binding must not change,
 * so it is run byte for byte against the source both before and after that
 * change.
 *
 * Expected values never come from the registry itself. Records are written
 * out literally, and hashes are computed here from the page's own text with
 * the public hashing functions. R2 and R4 use a page with NO title and a body
 * padded with blank lines, because that is where a record (title falls back to
 * the page part, body trimmed) and a hash (title empty, body as parsed) differ.
 *
 * Nothing is injected. Every project used here is the fixture's own temp root.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { buildEmbeddingText } from "../../src/utils/embeddings-pages.js";
import {
  buildLiveRegistryEntry, buildSurfaceEligibleCandidates, loadPageRecordPairsByPageId, loadPageRecordsByPageId,
} from "../../src/utils/page-registry.js";
import { hashChunkText, splitIntoChunks } from "../../src/utils/retrieval.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const project = useTempRoot();
const PAGE = (title: string, summary: string): string => `---\ntitle: ${title}\nsummary: ${summary}\n---\n\nBody of ${title}.\n`;
/** Everything after the frontmatter of {@link UNTITLED}, exactly as written. */
const PADDED_BODY = "\n\n  First paragraph.\n\nSecond paragraph.\n\n\n";
const UNTITLED = `---\nsummary: Only a summary\n---\n${PADDED_BODY}`;
const UNTITLED_HASHES = {
  embeddingTextHash: hashChunkText(buildEmbeddingText({ title: "", summary: "Only a summary" })),
  chunkHashes: splitIntoChunks(PADDED_BODY).map(hashChunkText),
};

/** Write one file under the project, creating its directory, and return its path. */
async function put(relative: string, content: string): Promise<string> {
  const file = path.join(project.dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

describe("the live page registry on real files, as it behaves today", () => {
  it("R1 loads ids in the order given, repeats a repeated id and drops an absent one", async () => {
    await put("wiki/concepts/a.md", PAGE("A", "sa"));
    await put("wiki/queries/b.md", PAGE("B", "sb"));
    const b = { pageId: "queries/b", record: { slug: "b", title: "B", summary: "sb", body: "Body of B." } };
    const a = { pageId: "concepts/a", record: { slug: "a", title: "A", summary: "sa", body: "Body of A." } };
    expect(await loadPageRecordPairsByPageId(project.dir, ["queries/b", "concepts/a", "concepts/ghost", "queries/b"])).toEqual([b, a, b]);
  });

  it("R2 titles an untitled page with its page part, trims its body and defaults a missing summary", async () => {
    await put("wiki/concepts/plain.md", UNTITLED);
    await put("wiki/concepts/bare.md", "# Just text\n");
    expect(await loadPageRecordsByPageId(project.dir, ["concepts/plain", "concepts/bare"])).toEqual([
      { slug: "plain", title: "plain", summary: "Only a summary", body: "First paragraph.\n\nSecond paragraph." },
      { slug: "bare", title: "bare", summary: "", body: "# Just text" },
    ]);
  });

  it("R3 drops a directory named like a page without a throw and still loads its sibling", async () => {
    await fs.mkdir(path.join(project.dir, "wiki/concepts/x.md"));
    await put("wiki/concepts/real.md", PAGE("Real", "sr"));
    const records = await loadPageRecordsByPageId(project.dir, ["concepts/x", "concepts/real"]);
    expect(records).toEqual([{ slug: "real", title: "Real", summary: "sr", body: "Body of Real." }]);
  });

  it("R4 hashes an untitled, padded page from its raw text and has no entry for five refusals", async () => {
    const file = await put("wiki/concepts/plain.md", UNTITLED);
    const outside = await put("outside/secret.md", PAGE("Secret", "ss"));
    await fs.symlink(outside, path.join(project.dir, "wiki/concepts/secret.md"));
    const real = await fs.realpath(file);
    expect(await buildLiveRegistryEntry(project.dir, "concepts/plain")).toEqual({
      capturedRealpath: real, expectedCanonicalDir: path.dirname(real), ...UNTITLED_HASHES,
    });
    const refused = ["concepts/ghost", "concepts/secret", "nope/plain", "../../etc/passwd"];
    for (const pageId of refused) expect(await buildLiveRegistryEntry(project.dir, pageId), pageId).toBeNull();
    expect(await buildLiveRegistryEntry(path.join(project.dir, "no-such-project"), "concepts/plain")).toBeNull();
  });

  it("R5 lists candidates by namespace in the order asked, skipping an unknown one and ineligible pages", async () => {
    await put("wiki/queries/q.md", PAGE("Q", "sq"));
    await put("wiki/concepts/c.md", "---\ntitle: C\n---\n\nBody of C.\n");
    await put("wiki/concepts/orphan.md", "---\ntitle: O\norphaned: true\n---\n\nBody.\n");
    await put("wiki/concepts/untitled.md", UNTITLED);
    expect(await buildSurfaceEligibleCandidates(project.dir, "search", ["queries", "nope", "concepts"])).toEqual([
      { pageId: "queries/q", slug: "q", title: "Q", summary: "sq" },
      { pageId: "concepts/c", slug: "c", title: "C", summary: "" },
    ]);
  });
});
