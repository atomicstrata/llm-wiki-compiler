/**
 * @file test/storage/typed-import-binding.test.ts
 * @description The typed leg of OKF import as ONE body over `TypedImportSteps`
 * (`applyTypedDocsWith`), none of which takes a project root, against the root
 * form `applyTypedDocs`.
 *
 * HOW IT IS BUILT. Memory steps that log every call answer staging, the
 * fallback candidate write, the candidate read, the promotion and the delete.
 * They pin each doc's path: typed staging, the untrusted stop, the trusted
 * promotion and its vanished/refused arms, the immediate fallback for an
 * unresolved type, the staging errors that fall back versus the ones that abort
 * every remaining doc, and doc order. The root form is shown handing each
 * incumbent the root and the body's exact arguments.
 *
 * NOT SHOWN HERE: staging, promotion and the candidate store themselves; the
 * import and trust suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as candidates from "../../src/compiler/candidates.js";
import { applyTypedDocs, applyTypedDocsWith, type TypedImportSteps } from "../../src/import/profile-import.js";
import type { MappedTypedOkfDoc } from "../../src/import/types.js";
import * as promote from "../../src/trust/promote.js";
import * as staging from "../../src/trust/staging.js";
import { UnknownEntityTypeError } from "../../src/trust/staging.js";

afterEach(() => { vi.restoreAllMocks(); });

const PROFILE = { schemaVersion: 1, profileId: "p", entities: {} } as never;
/** The untyped concept form every doc carries for the fallback. */
const untypedOf = (slug: string, okfPath: string) => ({ title: slug, slug, summary: "", sources: [], body: "b", okfPath }) as never;
/** A doc typed as a `notes` entity. */
const doc = (slug: string): MappedTypedOkfDoc => ({
  entityType: "notes", directory: "wiki/notes", typedBody: `---\ntitle: ${slug}\n---\n`,
  slug, okfPath: `notes/${slug}.md`, untyped: untypedOf(slug, `notes/${slug}.md`),
});
/** A doc whose entity type did not resolve: NO entityType or typedBody, only the fallback reason. */
const unresolvedDoc = (slug: string): MappedTypedOkfDoc => ({
  fallbackReason: `unknown entity type "x"`, slug, okfPath: `x/${slug}.md`, untyped: untypedOf(slug, `x/${slug}.md`),
});

/** What the memory steps answer, by slug. */
interface ImportWorld { stageFault?: Record<string, Error>; vanished?: string[]; promoteFault?: Record<string, Error> }

/** Memory typed-import steps; each call logged. */
function stepsOf(log: string[], world: ImportWorld = {}): TypedImportSteps {
  return {
    stageEntity: async (input) => { log.push(`stage ${input.entityType}/${input.slug}`); const fault = world.stageFault?.[input.slug]; if (fault) throw fault; return { id: `cand-${input.slug}` } as never; },
    writeCandidate: async (draft) => { log.push(`fallback ${draft.slug} ${draft.heldReasons?.[0]?.detail}`); },
    readCandidate: async (id) => { log.push(`read ${id}`); return world.vanished?.includes(id) ? null : { id } as never; },
    promoteTyped: async (candidate) => { log.push(`promote ${candidate.id}`); const fault = world.promoteFault?.[candidate.id]; if (fault) throw fault; },
    deleteCandidate: async (id) => { log.push(`delete ${id}`); },
  };
}

/** Apply `docs` over memory: outcome kinds (with reasons) and the log. */
async function apply(docs: MappedTypedOkfDoc[], trusted: boolean, world: ImportWorld = {}) {
  const log: string[] = [];
  const outcomes = await applyTypedDocsWith(stepsOf(log, world), docs, PROFILE, trusted);
  return { log, kinds: outcomes.map(({ outcome, reason }) => (reason === undefined ? outcome : `${outcome}: ${reason}`)) };
}

describe("the typed import leg as a root-free body", () => {
  it("T1 stages each typed doc in order, stops there untrusted, and promotes then deletes when trusted", async () => {
    expect(await apply([doc("a"), doc("b")], false)).toEqual({ kinds: ["staged-typed", "staged-typed"], log: ["stage notes/a", "stage notes/b"] });
    expect(await apply([doc("a")], true)).toEqual({ kinds: ["promoted-typed"], log: ["stage notes/a", "read cand-a", "promote cand-a", "delete cand-a"] });
  });

  it("T2 an unresolved type falls back at once; a contract-class staging error falls back with its message", async () => {
    expect(await apply([unresolvedDoc("u")], true)).toEqual({ kinds: ['mismatch-fallback: unknown entity type "x"'], log: ['fallback u profile-mismatch: unknown entity type "x"'] });
    const unknown = new UnknownEntityTypeError("notes");
    expect(await apply([doc("a")], true, { stageFault: { a: unknown } })).toEqual({
      kinds: [`mismatch-fallback: ${unknown.message}`], log: ["stage notes/a", `fallback a profile-mismatch: ${unknown.message}`],
    });
  });

  it("T3 any other staging error aborts every remaining doc", async () => {
    const log: string[] = [];
    await expect(applyTypedDocsWith(stepsOf(log, { stageFault: { a: new Error("EIO") } }), [doc("a"), doc("b")], PROFILE, true)).rejects.toThrow("EIO");
    expect(log).toEqual(["stage notes/a"]);
  });

  it("T4 a vanished candidate or a refused promotion leaves the doc staged for review, never deleted", async () => {
    expect(await apply([doc("a")], true, { vanished: ["cand-a"] })).toEqual({ kinds: ["staged-typed: candidate vanished before promotion"], log: ["stage notes/a", "read cand-a"] });
    expect(await apply([doc("a")], true, { promoteFault: { "cand-a": new Error("planner refused") } })).toEqual({
      kinds: ["staged-typed: promotion-refused: planner refused"], log: ["stage notes/a", "read cand-a", "promote cand-a"],
    });
  });
});

describe("the root form", () => {
  it("Z1 hands each incumbent the root and the body's exact arguments", async () => {
    const stage = vi.spyOn(staging, "stageEntityPage").mockResolvedValue({ id: "cand-a" } as never);
    const write = vi.spyOn(candidates, "writeCandidate").mockResolvedValue({} as never);
    const read = vi.spyOn(candidates, "readCandidate").mockResolvedValue({ id: "cand-a" } as never);
    const promoted = vi.spyOn(promote, "applyTypedCandidate").mockResolvedValue("concepts/a");
    const remove = vi.spyOn(candidates, "deleteCandidate").mockResolvedValue(true);
    await applyTypedDocs("/project", [doc("a"), unresolvedDoc("u")], PROFILE, true);
    expect(stage.mock.calls).toEqual([["/project", { entityType: "notes", slug: "a", body: "---\ntitle: a\n---\n", profile: PROFILE,
      existingStagedCount: 0, reviewMode: "imported", heldReasons: [{ code: "imported-okf" }] }]]);
    expect([read.mock.calls, promoted.mock.calls, remove.mock.calls]).toEqual([[["/project", "cand-a"]], [["/project", { id: "cand-a" }]], [["/project", "cand-a"]]]);
    expect([stage.mock.calls.length, write.mock.calls.length, write.mock.calls[0]?.[0]]).toEqual([1, 1, "/project"]);
    expect((write.mock.calls[0]?.[1] as { targetDirectory: string; reviewMode: string })).toMatchObject({ targetDirectory: "concepts", reviewMode: "imported" });
  });
});
