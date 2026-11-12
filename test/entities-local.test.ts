/**
 * @file test/entities-local.test.ts
 * @description The entity step's disk reads: the timeline's "People this day"
 * comes from the extraction cache and the alias registry, and lists only records
 * whose page exists; a malformed registry is an error that names the file.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { listRecordMentions } from "../src/entities/local.js";
import type { ExtractionCache } from "../src/entities/extract.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A project with the given cache, registry and person pages. */
async function project(cache: ExtractionCache | null, registry: string | null, pages: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-entities-"));
  roots.push(root);
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await mkdir(path.join(root, "wiki", "person"), { recursive: true });
  if (cache) await writeFile(path.join(root, ".llmwiki", "entities.json"), JSON.stringify(cache));
  if (registry !== null) await writeFile(path.join(root, ".llmwiki", "aliases.json"), registry);
  for (const slug of pages) await writeFile(path.join(root, "wiki", "person", `${slug}.md`), `---\ntitle: ${slug}\nentitySignature: x\n---\n\nBody.\n`);
  return root;
}

const CACHE: ExtractionCache = {
  digest: "d",
  sources: { "chat.md": { hash: "h", chunks: [{ hash: "c", records: { person: [
    { name: "Alex", fields: {}, lines: [{ start: 2, end: 2 }] },
    { name: "Alex Kim", fields: {}, lines: [{ start: 5, end: 6 }] },
    { name: "Ana", fields: {}, lines: [{ start: 3, end: 3 }] },
  ] } }] } },
};

describe("the people a timeline day can list", () => {
  it("joins names the registry says are one, and lists only records that have a page", async () => {
    const root = await project(CACHE, JSON.stringify({ entities: { person: { "alex-kim": ["Alex Kim", "Alex"] } } }), ["alex-kim"]);
    expect(await listRecordMentions(root, "person")).toEqual([{
      target: "person/alex-kim", title: "Alex Kim",
      spans: [{ file: "chat.md", lines: { start: 2, end: 2 } }, { file: "chat.md", lines: { start: 5, end: 6 } }],
    }]);
  });

  it("does not list a record whose page was written by hand", async () => {
    const root = await project(CACHE, null, []);
    await writeFile(path.join(root, "wiki", "person", "ana.md"), "---\ntitle: Ana\n---\n\nMine.\n");
    expect(await listRecordMentions(root, "person")).toEqual([]);
  });

  it("lists nobody before the first extraction", async () => {
    expect(await listRecordMentions(await project(null, null, ["ana"]), "person")).toEqual([]);
  });

  it("treats a cache of the wrong shape as no cache", async () => {
    const root = await project({ digest: "d", sources: null } as unknown as ExtractionCache, null, ["ana"]);
    expect(await listRecordMentions(root, "person")).toEqual([]);
  });

  it("names the registry file when it is not valid JSON", async () => {
    const root = await project(CACHE, "{ not json", ["ana"]);
    await expect(listRecordMentions(root, "person")).rejects.toThrow(/aliases\.json is not valid/);
  });
});
