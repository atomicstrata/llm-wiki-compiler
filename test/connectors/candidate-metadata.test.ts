/**
 * @file test/connectors/candidate-metadata.test.ts
 * @description Connector review candidate metadata persistence and sanitization.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCandidate, writeCandidate } from "../../src/compiler/candidates.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

const PROVENANCE = {
  connectorId: "crossref",
  connectorVersion: "1",
  sourceUrl: "https://api.crossref.org/works/10.123/example",
  fetchedAt: "2026-07-06T00:00:00.000Z",
  contentHash: "a".repeat(64),
  draftContentHash: "b".repeat(64),
  idempotencyKey: "c".repeat(64),
};

async function seedRaw(id: string, value: unknown): Promise<void> {
  const dir = path.join(root.dir, ".llmwiki", "candidates");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(value, null, 2), "utf8");
}

describe("connector candidate metadata", () => {
  it("persists and reads connector review metadata", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "paper",
      slug: "paper",
      summary: "",
      sources: [],
      body: "---\ntitle: Paper\n---\nBody",
      reviewMode: "connector",
      heldReasons: [{ code: "connector-fetched" }],
      connectorProvenance: PROVENANCE,
    });
    const read = await readCandidate(root.dir, candidate.id);
    expect(read?.reviewMode).toBe("connector");
    expect(read?.heldReasons).toEqual([{ code: "connector-fetched" }]);
    expect(read?.connectorProvenance?.draftContentHash).toBe("b".repeat(64));
  });

  it("drops malformed connectorProvenance instead of trusting display fields", async () => {
    await seedRaw("bad-provenance", {
      id: "bad-provenance",
      title: "Bad",
      slug: "bad",
      summary: "",
      sources: [],
      body: "Body",
      generatedAt: "2026-07-06T00:00:00.000Z",
      reviewMode: "connector",
      heldReasons: [{ code: "connector-fetched" }],
      connectorProvenance: { ...PROVENANCE, sourceUrl: 7 },
    });
    const read = await readCandidate(root.dir, "bad-provenance");
    expect(read?.reviewMode).toBe("connector");
    expect(read?.connectorProvenance).toBeUndefined();
  });
});
