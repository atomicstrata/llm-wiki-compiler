/**
 * @file test/storage/citation-index-legacy.test.ts
 * @description The strict citation index through its ROOT function,
 * `collectAnswerCitationIndex`, on real files with nothing mocked. Two
 * existing tests already pin most of its rules on disk under an `fs/promises`
 * mock. This file adds four outcomes they do not state, so that running the
 * collector over injected sources cannot move them. It is run byte for byte
 * against the source both before and after.
 *
 * D1 pins the ORDER of effects: a fault in the retained pages is thrown before
 * the candidate store is looked at. Its second half shows the candidate fault
 * is real, by removing the page fault and getting the candidate store's error.
 * D2 pins a page's identity: an in-directory link keeps its OWN listed name and
 * carries its target's aliases. D3 pins that pending targets come in generation
 * order, not id order. D4 pins that a project reached through a linked root is
 * read through its resolved root, pages and candidates both.
 */

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { collectAnswerCitationIndex } from "../../src/citations/answer-index.js";
import { UnsafeCandidateDirError } from "../../src/compiler/candidate-store-paths.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const project = useTempRoot();
const at = (relative: string): string => path.join(project.dir, relative);

/** Write a pending candidate record that passes admission, generated at `generatedAt`. */
async function pend(id: string, generatedAt: string): Promise<void> {
  await mkdir(at(".llmwiki/candidates"), { recursive: true });
  const record = { id, slug: id, title: id, body: "b", sources: [], summary: "", generatedAt, reviewMode: "forced" };
  await writeFile(at(`.llmwiki/candidates/${id}.json`), JSON.stringify(record));
}

describe("the strict citation index through its root function, as it behaves today", () => {
  it("D1 throws a retained-page fault before the candidate store is looked at", async () => {
    await rm(at("wiki/concepts"), { recursive: true });
    await writeFile(at("wiki/concepts"), "a regular file where the page directory should be");
    await mkdir(at(".llmwiki"));
    await symlink(os.tmpdir(), at(".llmwiki/candidates"));
    await expect(collectAnswerCitationIndex(project.dir)).rejects.toMatchObject({ code: "ENOTDIR" });
    await rm(at("wiki/concepts"));
    await expect(collectAnswerCitationIndex(project.dir)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
  });

  it("D2 keeps an in-directory link under its own listed name, with its target's string aliases", async () => {
    await writeFile(at("wiki/concepts/alpha.md"), "---\naliases: [Alias One, 42]\n---\nbody");
    await symlink(at("wiki/concepts/alpha.md"), at("wiki/concepts/local.md"));
    const { retained } = await collectAnswerCitationIndex(project.dir);
    expect(retained).toHaveLength(2);
    expect(retained).toContainEqual({ id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", aliases: ["Alias One"] });
    expect(retained).toContainEqual({ id: "concepts/local", pageDirectory: "concepts", slug: "local", aliases: ["Alias One"] });
  });

  it("D3 lists pending targets in generation order, not id order", async () => {
    await pend("aaa", "2026-01-02T00:00:00.000Z");
    await pend("zzz", "2026-01-01T00:00:00.000Z");
    expect(await collectAnswerCitationIndex(project.dir)).toEqual({
      retained: [], pending: [{ target: "zzz", candidateId: "zzz" }, { target: "aaa", candidateId: "aaa" }],
    });
  });

  it("D4 reads pages and candidates of a project reached through a linked root", async () => {
    await writeFile(at("wiki/queries/question.md"), "no frontmatter");
    await pend("pending-one", "2026-01-01T00:00:00.000Z");
    const linked = `${project.dir}-linked`;
    await symlink(project.dir, linked);
    try {
      expect(await collectAnswerCitationIndex(linked)).toEqual({
        retained: [{ id: "queries/question", pageDirectory: "queries", slug: "question", aliases: [] }],
        pending: [{ target: "pending-one", candidateId: "pending-one" }],
      });
    } finally {
      await rm(linked);
    }
  });
});
