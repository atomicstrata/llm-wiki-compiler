/**
 * @file test/catalog/typed-upgrade.test.ts
 * @description The typed entity catalog across a profile change on a
 * `local-indexed` project, through the real bodies on real disk:
 * - a changed profile digest refuses the listing (`catalog_profile_stale`)
 *   until a catalog sync RE-PROJECTS every entity row under the new profile,
 *   after which the block equals the incumbent collector's again;
 * - THE CAPABILITY UPGRADE: a custom profile adopted after activation is
 *   prepared by `scale prepare`, which writes the capability `preparing` with
 *   no pending transition (status reports `preparing`, the gate blocks
 *   dependent work), prepares it, and publishes it `ready` in one last write;
 *   an upgrade whose step parks writes nothing more and stays `preparing`
 *   until a later `prepare` completes it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { catalogSync } from "../../src/catalog/facade.js";
import { routedListPages } from "../../src/catalog/routes.js";
import { listPages, type ListPagesProfileBlock } from "../../src/pages/list.js";
import { scaleGateRefusal } from "../../src/scale/gate.js";
import { diskScaleRecordIo } from "../../src/scale/record.js";
import { diskScaleTransitionSteps, prepareExpectedScaleWith, scaleStatusFrom, setExpectedScaleWith, type ScaleTransitionSteps } from "../../src/scale/transition.js";
import { SAMPLE_PROFILE, writeMarkdownPage, writeProfileFile } from "../fixtures/profile-fixtures.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-typed-upgrade-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** The local steps with an unbounded free-space answer. */
function steps(overrides: Partial<ScaleTransitionSteps> = {}): ScaleTransitionSteps {
  return { ...diskScaleTransitionSteps(root), preflight: { freeBytes: async () => Number.MAX_SAFE_INTEGER }, ...overrides };
}

/** Two notes pages, prepared `local-indexed` (with or without the sample profile written first). */
async function preparedIndexed(withProfile: boolean): Promise<void> {
  if (withProfile) await writeProfileFile(root, SAMPLE_PROFILE);
  for (const slug of ["alpha", "beta"]) await writeMarkdownPage(root, "wiki/notes", slug, `---\ntitle: ${slug}\n---\nBody.`);
  expect((await setExpectedScaleWith(steps(), { request: { documents: 8_000 } })).readiness).toBe("ready");
}

/** A profile block in comparable form. */
const canonical = (block: ListPagesProfileBlock | undefined) => ({
  pages: [...(block?.entityPages ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)),
  problems: (block?.problems ?? []).map((problem) => JSON.stringify(problem)).sort(), total: block?.total, problemTotal: block?.problemTotal,
});

describe("a changed profile digest", () => {
  it("refuses the listing until a sync re-projects every entity row under the new profile", async () => {
    await preparedIndexed(true);
    const stricter = { ...SAMPLE_PROFILE, entities: { notes: { ...SAMPLE_PROFILE.entities.notes, requiredFields: ["title", "summary"], fields: { title: { type: "string" }, summary: { type: "string" } } } } };
    await writeFile(path.join(root, ".llmwiki", "profile.json"), JSON.stringify(stricter));
    await expect(routedListPages(root)).rejects.toMatchObject({ code: "catalog_profile_stale" });
    await catalogSync(root);
    const listed = await routedListPages(root, { limit: 1000 });
    expect(canonical(listed.profile)).toEqual(canonical((await listPages(root, {})).profile));
    expect(listed.profile?.problems?.map((problem) => problem.kind)).toEqual(["field-violation", "field-violation"]);
  });
});

describe("the capability upgrade of an active indexed project", () => {
  it("is prepared by scale prepare: preparing (status and gate) first, then ready, and the block is served", async () => {
    await preparedIndexed(false);
    await writeProfileFile(root, SAMPLE_PROFILE);
    const seen: unknown[] = [];
    const checkpoint = async () => { seen.push((await scaleStatusFrom(diskScaleRecordIo(root))).readiness, (await scaleGateRefusal(root))?.block); };
    const report = await prepareExpectedScaleWith(steps({ checkpoint }));
    expect(seen).toEqual(["preparing", "scale-transition-pending"]);
    expect([report.readiness, report.record?.pending, report.record?.version === 1 ? [] : report.record?.capabilities]).toEqual(["ready", null, [{ name: "typed-entity-catalog-1", status: "ready" }]]);
    expect(canonical((await routedListPages(root, { limit: 1000 })).profile)).toEqual(canonical((await listPages(root, {})).profile));
  });

  it("stays preparing when its step parks, writing nothing more, until a later prepare completes it", async () => {
    await preparedIndexed(false);
    await writeProfileFile(root, SAMPLE_PROFILE);
    const parked = await prepareExpectedScaleWith(steps({ indexed: undefined }));
    expect([parked.readiness, (await scaleGateRefusal(root))?.block]).toEqual(["preparing", "scale-transition-pending"]);
    const revision = parked.record?.revision;
    const completed = await prepareExpectedScaleWith(steps());
    expect([completed.readiness, completed.record?.revision]).toEqual(["ready", revision]);
    expect(await scaleGateRefusal(root)).toBeNull();
  });
});
