/**
 * @file test/storage/okf-apply-binding.test.ts
 * @description The OKF import's APPLYING leg as ONE body over `OkfApplySteps`
 * (`applyOkfImportWith`), none of which takes a project root, against the root
 * form `runOkfImport`.
 *
 * HOW IT IS BUILT. Memory steps that log every call answer the lock, the intake
 * (a hand-built `ImportedOkfBundle`), the pending-candidate read, the per-page
 * candidate and live-page writes, the refresh, the typed and relation legs and
 * the bundle sections. They pin the whole order for a trusted write and an
 * untrusted stage, that the lock is taken quietly and released on every exit
 * after it was taken, the queue-capacity refusal before any write, the
 * partial-success refresh of only the pages written before a fault, and that a
 * default-profile import omits `typed` and `relationOutcomes` and reaches neither
 * leg. The root form is shown handing each incumbent the root and its old
 * arguments.
 *
 * NOT SHOWN HERE: the intake, the typed and relation legs, the refresh and the
 * candidate store themselves; `okf-import-binding`, `typed-import-binding`,
 * `relation-import-binding`, `derived-regeneration-binding` and the candidate
 * suites show those. The dry-run preview is `okf-import-binding` P1, P2.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as candidates from "../../src/compiler/candidates.js";
import * as bundleBlockRead from "../../src/import/bundle-block-read.js";
import * as okfImport from "../../src/import/okf-import.js";
import * as okfRefresh from "../../src/import/okf-refresh.js";
import * as profileImport from "../../src/import/profile-import.js";
import * as relationImport from "../../src/import/relation-import.js";
import { LockUnavailableError, QueueFullError } from "../../src/import/run-errors.js";
import { applyOkfImportWith, runOkfImport, type OkfApplySteps, type OkfImportOptions } from "../../src/import/run.js";
import type { ImportedOkfBundle } from "../../src/import/okf-import.js";
import type { MappedOkfPage, TypedImportOutcome } from "../../src/import/types.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as lock from "../../src/utils/lock.js";
import * as markdown from "../../src/utils/markdown.js";
import { isQuiet } from "../../src/utils/output.js";

afterEach(() => { vi.restoreAllMocks(); });

const ROOT = "/memory/project";
const DIR = "/memory/bundle";
const PROFILE = { profileId: "newsroom" } as never;
const RELATION = { from: "desks/a", to: "desks/b", type: "covers" } as never;
const PROMOTED: TypedImportOutcome = { slug: "metro", okfPath: "desks/metro.md", outcome: "promoted-typed", entityType: "desks" } as TypedImportOutcome;
const STAGED: TypedImportOutcome = { slug: "metro", okfPath: "desks/metro.md", outcome: "staged-typed", entityType: "desks" } as TypedImportOutcome;

/** A mapped page; `valid` false gives it an unwritable (empty) body. */
const page = (slug: string, targetDirectory: "concepts" | "queries" = "concepts", valid = true): MappedOkfPage => ({
  slug, title: slug, summary: `${slug} summary`, sources: [], targetDirectory, okfPath: `${targetDirectory}/${slug}.md`,
  body: valid ? `---\ntitle: ${slug}\n---\n\n${slug} body.\n` : "",
});

/** A profiled bundle: two valid pages, one invalid, one typed doc, a bundle block with one relation. */
const PROFILED: ImportedOkfBundle = {
  pages: [page("alpha"), page("beta", "queries"), page("bad", "concepts", false)], typed: [{ slug: "metro" } as never],
  skipped: [{ slug: "taken", okfPath: "concepts/taken.md", reason: "live-page" }], typedSkipped: [],
  bundleBlock: { relations: [RELATION] } as never, profile: { profile: PROFILE } as never,
};

/** What the memory steps answer, where a case says so. */
interface ApplyWorld { imported?: ImportedOkfBundle; locked?: boolean; pending?: number; writeFault?: string; typed?: TypedImportOutcome[] }

/** Memory apply steps; each call logged, the lock's quiet scope noted. */
function stepsOf(log: string[], world: ApplyWorld = {}): OkfApplySteps & { drafts: unknown[] } {
  const drafts: unknown[] = [];
  return {
    drafts,
    acquireLock: async () => { log.push(`lock quiet=${isQuiet()}`); return world.locked ?? true; },
    releaseLock: async () => { log.push("release"); },
    importBundle: async (dir, onWarn) => { log.push(`import ${dir}`); onWarn("one warning"); return world.imported ?? PROFILED; },
    listCandidates: async () => { log.push("list"); return Array(world.pending ?? 0).fill({}); },
    writeCandidate: async (draft) => { log.push(`stage ${draft.slug}`); drafts.push(draft); },
    writePage: async (relativePath) => { log.push(`write ${relativePath}`); if (relativePath.includes(world.writeFault ?? "\0")) throw new Error("disk full"); },
    refresh: async (pageIds) => { log.push(`refresh ${pageIds.join(",")}`); },
    applyTyped: async (typed, _profile, trusted) => { log.push(`typed ${typed.length} trusted=${trusted}`); return world.typed ?? [PROMOTED]; },
    bundleSections: async () => { log.push("sections"); return { workflows: [] } as never; },
    applyRelations: async (_profile, entries, trusted) => { log.push(`relations ${entries.length} trusted=${trusted}`); return [{ outcome: "imported" }] as never; },
  };
}

/** Apply over memory steps: the report (or the refusal) and the log. */
async function apply(opts: OkfImportOptions, world: ApplyWorld = {}) {
  const log: string[] = [];
  const steps = stepsOf(log, world);
  const report = await applyOkfImportWith(steps, DIR, opts).catch((error: Error) => error);
  return { report, log, drafts: steps.drafts };
}

describe("the OKF apply leg as a root-free body", () => {
  it("A1 trusted: quiet lock, intake, writes, their refresh, typed leg, promoted refresh, sections, relations, release", async () => {
    const { report, log } = await apply({ trusted: true, maxNewCandidates: 0 });
    expect(log).toEqual([
      "lock quiet=true", `import ${DIR}`, "write wiki/concepts/alpha.md", "write wiki/queries/beta.md", "refresh concepts/alpha,queries/beta",
      "typed 1 trusted=true", "refresh desks/metro", "sections", "relations 1 trusted=true", "release",
    ]);
    expect(report).toEqual({
      mode: "written", pages: [{ slug: "alpha", okfPath: "concepts/alpha.md", targetDirectory: "concepts" }, { slug: "beta", okfPath: "queries/beta.md", targetDirectory: "queries" }],
      skipped: [...PROFILED.skipped, { slug: "bad", okfPath: "concepts/bad.md", reason: "invalid-page" }], warnings: ["one warning"], workflows: [],
      typed: [PROMOTED], relationOutcomes: [{ outcome: "imported" }], nextAction: "2 page(s) written live.",
    });
  });

  it("A2 untrusted: checks the queue, stages each valid page as an imported candidate, and refreshes nothing unpromoted", async () => {
    const { report, log, drafts } = await apply({ maxNewCandidates: 3 }, { typed: [STAGED] });
    expect(log).toEqual(["lock quiet=true", `import ${DIR}`, "list", "stage alpha", "stage beta", "typed 1 trusted=false", "sections", "relations 1 trusted=false", "release"]);
    expect(drafts[0]).toEqual({
      title: "alpha", slug: "alpha", summary: "alpha summary", sources: [], body: page("alpha").body,
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }], targetDirectory: "concepts", okfPath: "concepts/alpha.md",
    });
    expect(report).toMatchObject({ mode: "staged", typed: [STAGED], nextAction: "Review and approve before it goes live: llmwiki review list." });
  });

  it("A3 a full queue (pending + valid + typed over the cap) refuses before any write and still releases", async () => {
    const { report, log } = await apply({ maxNewCandidates: 3 }, { pending: 1 });
    expect([report, log]).toEqual([new QueueFullError(), ["lock quiet=true", `import ${DIR}`, "list", "release"]]);
    const busy = await apply({ trusted: true });
    expect(busy.log.includes("list")).toBe(false);
  });

  it("A4 a write fault refreshes only the pages written before it, then rethrows past the legs; a first-page fault refreshes nothing", async () => {
    const { report, log } = await apply({ trusted: true }, { writeFault: "beta" });
    expect([(report as Error).message, log]).toEqual(["disk full", [
      "lock quiet=true", `import ${DIR}`, "write wiki/concepts/alpha.md", "write wiki/queries/beta.md", "refresh concepts/alpha", "release",
    ]]);
    const first = await apply({ trusted: true }, { writeFault: "alpha" });
    expect(first.log.filter((line) => line.startsWith("refresh"))).toEqual([]);
  });

  it("A5 a busy lock refuses with no release; a default-profile import omits typed and relations and reaches neither leg", async () => {
    const busy = await apply({}, { locked: false });
    expect([busy.report, busy.log]).toEqual([new LockUnavailableError(), ["lock quiet=true"]]);
    const plain = { ...PROFILED, typed: [], bundleBlock: undefined, profile: undefined };
    const { report, log } = await apply({}, { imported: plain });
    expect(Object.keys(report)).toEqual(["mode", "pages", "skipped", "warnings", "nextAction"]);
    expect(log).toEqual(["lock quiet=true", `import ${DIR}`, "stage alpha", "stage beta", "release"]);
  });

  it("A6 relations without an active profile are reported skipped-no-profile without reaching the relation leg", async () => {
    const { report, log } = await apply({ trusted: true }, { imported: { ...PROFILED, typed: [], profile: undefined } });
    expect((report as { relationOutcomes: Array<{ outcome: string }> }).relationOutcomes.map(({ outcome }) => outcome)).toEqual(["skipped-no-profile"]);
    expect(log.some((line) => line.startsWith("relations") || line.startsWith("typed"))).toBe(false);
  });
});

describe("the root form", () => {
  it("Z1 hands each incumbent the root and its old arguments", async () => {
    const spies = {
      lock: vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(true), release: vi.spyOn(lock, "releaseLock").mockResolvedValue(),
      intake: vi.spyOn(okfImport, "importOkfBundle").mockResolvedValue(PROFILED), list: vi.spyOn(candidates, "listCandidates").mockResolvedValue([]),
      stage: vi.spyOn(candidates, "writeCandidate").mockResolvedValue({} as never), write: vi.spyOn(markdown, "atomicWrite").mockResolvedValue(),
      refresh: vi.spyOn(okfRefresh, "refreshAfterImport").mockResolvedValue(), typed: vi.spyOn(profileImport, "applyTypedDocs").mockResolvedValue([PROMOTED]),
      sections: vi.spyOn(bundleBlockRead, "buildBundleSections").mockResolvedValue({}), relations: vi.spyOn(relationImport, "applyBundleRelations").mockResolvedValue([]),
    };
    await runOkfImport(ROOT, DIR, { maxNewCandidates: 9 });
    await runOkfImport(ROOT, DIR, { trusted: true });
    expect([spies.lock.mock.calls[0], spies.release.mock.calls[0], spies.intake.mock.calls[0]?.slice(0, 3), spies.list.mock.calls[0]]).toEqual([[ROOT, "ordinary"], [ROOT], [DIR, ROOT, {}], [ROOT]]);
    expect([spies.stage.mock.calls[0]?.[0], spies.write.mock.calls[0], spies.refresh.mock.calls.at(-1)]).toEqual([ROOT, [`${ROOT}/wiki/concepts/alpha.md`, page("alpha").body], [ROOT, ["desks/metro"]]]);
    expect([spies.typed.mock.calls[0], spies.sections.mock.calls[0]?.[0], spies.relations.mock.calls[1]]).toEqual([[ROOT, PROFILED.typed, PROFILE, false], ROOT, [ROOT, PROFILE, [RELATION], true]]);
  });
});
