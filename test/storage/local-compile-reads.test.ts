/**
 * @file test/storage/local-compile-reads.test.ts
 * @description Boundary witness for the legacy-compatibility read binding: the
 * review-mode compile's content and configuration reads really go through it.
 *
 * The project here exists ONLY in memory. {@link localCompileAccess} is the
 * same composition `diskCompileAccess` uses, given a memory-backed binding in
 * place of the disk one; the test supplies only the two records the binding
 * does not cover (an empty compile state and a collecting proposal queue). No
 * `CompileAccess` read method is reimplemented here. The real review-mode
 * compile then runs under the deterministic fixture model, whose answers are a
 * function of the bytes it is handed. A read that still bypassed the binding
 * would look at a directory that does not exist and find nothing.
 */

import { describe, expect, it } from "bun:test";
import { localCompileAccess, type CompileAccess } from "../../src/compiler/compile-access.js";
import type { CandidateDraft } from "../../src/compiler/candidates.js";
import { runReviewProposal } from "../../src/compiler/compile-phases.js";
import { fixtureModelOverride } from "../fixtures/fixture-provider.js";
import type { LegacyLocalReads, LocalEntry } from "../../src/storage/legacy-local-reads.js";
import { withQuiet } from "../../src/utils/output.js";
import { runWithProviderOverride } from "../../src/utils/provider.js";
import type { CompileResult, ReviewCandidate } from "../../src/utils/types.js";

/** A rejection shaped like Node's for a path that is not there. */
function absent(relPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${relPath}`), { code: "ENOENT" });
}

/** A read binding over an in-memory map of project-relative path to text. No directory backs it. */
function memoryReads(files: Record<string, string>): LegacyLocalReads {
  const isDirectory = (dir: string): boolean => Object.keys(files).some((file) => file.startsWith(`${dir}/`));
  const entriesOf = (dir: string): LocalEntry[] => {
    if (!isDirectory(dir)) throw absent(dir);
    const names = new Set(Object.keys(files).filter((file) => file.startsWith(`${dir}/`))
      .map((file) => file.slice(dir.length + 1).split("/")[0]));
    return [...names].map((name) => ({ name, kind: `${dir}/${name}` in files ? "file" : "directory" }));
  };
  const confined = (relPath: string) => (relPath in files ? { content: files[relPath] } : { dropped: "escapes-dir" });
  return {
    readText: async (relPath) => { if (!(relPath in files)) throw absent(relPath); return files[relPath]; },
    exists: async (relPath) => relPath in files || isDirectory(relPath),
    statNoFollow: async (relPath) => { if (relPath in files) return "file"; if (isDirectory(relPath)) return "directory"; throw absent(relPath); },
    listNames: async (dir) => entriesOf(dir).map((entry) => entry.name),
    realDirectory: async (dir) => (isDirectory(dir)
      ? { listEntries: async (relative) => entriesOf(relative ? `${dir}/${relative}` : dir) } : null),
    readConfinedPage: async (dir, slug) => confined(`${dir}/${slug}.md`),
    readConfinedFile: async (relPath) => confined(relPath),
    locate: (relPath) => `memory:${relPath}`,
  };
}

/** The seam over a memory-only project, with the drafts it emitted. */
function memoryProject(files: Record<string, string>): { access: CompileAccess; drafts: CandidateDraft[] } {
  const drafts: CandidateDraft[] = [];
  const access = localCompileAccess(memoryReads(files), {
    readState: async () => ({ version: 1, indexHash: "", sources: {} }),
    pendingSourceStates: async () => new Map(),
    emitCandidate: async (draft) => {
      drafts.push(draft);
      return { ...draft, id: `${draft.slug}-memory`, generatedAt: "fixed" } as ReviewCandidate;
    },
    discardCandidatesForSlug: async () => {},
  });
  return { access, drafts };
}

/** Run the real review-mode compile over `access` under the deterministic fixture model. */
function compileForReview(access: CompileAccess): Promise<CompileResult> {
  return runWithProviderOverride(fixtureModelOverride(), () => withQuiet(() => runReviewProposal(access, { review: true })));
}

const MEMORY_PROJECT = {
  "sources/kept.md": "# Tidal Resonance\n\nTides resonate in narrow bays.\n",
  "sources/excluded.md": "# Never Compiled\n\nConfiguration excludes this source.\n",
  ".llmwiki/config.json": JSON.stringify({ version: 1, sources: { exclude: ["excluded.md"] } }),
  "wiki/concepts/harbor-seiche.md": "---\ntitle: Harbor Seiche\n---\n\nAn existing page.\n",
  "wiki/index.md": "# Index\n\n- [[harbor-seiche|Harbor Seiche]]\n",
};

describe("review-mode compile over a memory-only read binding", () => {
  it("selects sources by the configuration it read through the binding", async () => {
    const { access, drafts } = memoryProject(MEMORY_PROJECT);
    const result = await compileForReview(access);
    expect(result).toMatchObject({ compiled: 1, errors: [], concepts: ["Tidal Resonance"] });
    expect(drafts.map((draft) => draft.sources)).toEqual([["kept.md"]]);
  });

  it("generates the candidate from source text that exists only in memory", async () => {
    const { access, drafts } = memoryProject(MEMORY_PROJECT);
    await compileForReview(access);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ title: "Tidal Resonance", slug: "tidal-resonance", summary: "Tides resonate in narrow bays." });
    expect(Object.keys(drafts[0].sourceStates ?? {})).toEqual(["kept.md"]);
  });

  it("changes the model's input when only an existing memory page is retitled", async () => {
    const inputDigestOf = async (files: Record<string, string>): Promise<string | undefined> => {
      const { access, drafts } = memoryProject(files);
      await compileForReview(access);
      return /fixture output for input ([0-9a-f]+)/u.exec(drafts[0].body)?.[1];
    };
    const baseline = await inputDigestOf(MEMORY_PROJECT);
    expect(baseline).toMatch(/^[0-9a-f]{16}$/u);
    expect(await inputDigestOf(MEMORY_PROJECT)).toBe(baseline);
    const retitled = { ...MEMORY_PROJECT, "wiki/concepts/harbor-seiche.md": "---\ntitle: Renamed Seiche\n---\n\nAn existing page.\n" };
    expect(await inputDigestOf(retitled)).not.toBe(baseline);
  });

  it("finds nothing to compile when the memory project has no sources directory", async () => {
    const { access, drafts } = memoryProject({ "wiki/index.md": "# Index\n" });
    expect(await compileForReview(access)).toMatchObject({ compiled: 0, skipped: 0 });
    expect(drafts).toEqual([]);
  });
});
