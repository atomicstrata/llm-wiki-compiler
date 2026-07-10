/**
 * @file test/state-slug-safety.test.ts
 * @description FIX 3 — a symlinked / poisoned state.json must never mint an
 * out-of-tree write.
 *
 * (a) `readStateClassified` validates every `concepts[]` / `frozenSlugs[]` entry
 *     is a safe filename component; a `../../../escape` slug classifies CORRUPT.
 * (b) `orphanPage` gates the slug, so even a bypassed validator can't path-join
 *     a file outside root.
 * (c) the state.json read is O_NOFOLLOW: a symlinked state.json fails closed
 *     (corrupt), not read-through to outside content.
 */

import { describe, it, expect } from "vitest";
import { symlink, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { readStateClassified } from "../src/utils/state.js";
import { orphanUnownedFrozenPages } from "../src/compiler/orphan.js";
import { CompileStateDraft } from "../src/compiler/compile-state-draft.js";
import { STATE_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import { writeRawTestStateJson } from "./fixtures/state-json.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("state-slug");

/** A valid v1 state shape with a single source whose `concepts` are caller-chosen. */
function stateWithConcepts(concepts: string[]): string {
  return JSON.stringify({
    version: 1,
    indexHash: "",
    sources: { "a.md": { hash: "h", compiledAt: "t", concepts } },
  });
}

describe("state.json slug safety (FIX 3)", () => {
  it("(a) classifies corrupt when a concepts[] slug escapes root", async () => {
    await writeRawTestStateJson(ctx.root, stateWithConcepts(["../../../escape"]));
    expect((await readStateClassified(ctx.root)).status).toBe("corrupt");
  });

  it("(a) classifies corrupt when a frozenSlugs[] entry escapes root", async () => {
    await writeRawTestStateJson(
      ctx.root,
      JSON.stringify({ version: 1, indexHash: "", sources: {}, frozenSlugs: ["../../x"] }),
    );
    expect((await readStateClassified(ctx.root)).status).toBe("corrupt");
  });

  it("(a) still reads a valid state with safe slugs", async () => {
    await writeRawTestStateJson(ctx.root, stateWithConcepts(["safe-slug"]));
    const result = await readStateClassified(ctx.root);
    expect(result.status).toBe("ok");
    expect(result.state.sources["a.md"].concepts).toEqual(["safe-slug"]);
  });

  it("(b) orphanPage never writes outside root for an unsafe frozen slug", async () => {
    const { root, outside } = ctx;
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    // The orphan flow joins root/CONCEPTS_DIR/<slug>.md; an escaping slug must be
    // skipped. The frozen slug is unowned in the (empty) draft, so the pass
    // reaches orphanPage — whose slug gate is the floor under test.
    const draft = await CompileStateDraft.load(root);
    await orphanUnownedFrozenPages(root, draft, new Set([`../../../${path.basename(outside)}/secret`]));
    expect(existsSync(path.join(path.dirname(outside), path.basename(outside), "secret.md"))).toBe(false);
    expect((await readdir(outside)).filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("(c) a symlinked state.json fails closed (corrupt), not read-through", async () => {
    const { root, outside } = ctx;
    const sink = path.join(outside, "leak.json");
    await writeFile(sink, stateWithConcepts(["safe"]), "utf-8");
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await symlink(sink, path.join(root, STATE_FILE)); // symlinked state.json → outside
    expect((await readStateClassified(root)).status).toBe("corrupt");
  });
});
