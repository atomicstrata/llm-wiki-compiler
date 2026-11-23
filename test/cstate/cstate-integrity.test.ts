/**
 * @file test/cstate/cstate-integrity.test.ts
 * @description Integrity of the segmented compile state on a project
 * upgraded through the real bodies:
 * - a store fault PROPAGATES through `readState` and `readStateClassified`
 *   with its own code, never as a corrupt `state.json` (no `.bak`, no empty
 *   state);
 * - indexed stores with a missing scale record refuse every state read
 *   (`scale-state-unreadable`), never serving `state.json`;
 * - source keys: ordinary names (dot-files, spaces, nested) are kept; NUL,
 *   backslash, absolute, empty, `.`/`..` components and `__proto__` are
 *   refused before any write, and an import of such a state parks;
 * - ordinals stay within the 12-digit key range;
 * - full verification refuses a row outside the known namespaces, a missing
 *   owner row, frozen rows without the meta's frozen list, and two frozen
 *   slugs claiming one position.
 */

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { isRepresentableSourceKey, isSourceRow, ORDINAL_LIMIT, ownerKey } from "../../src/cstate/contracts.js";
import { openCompileState, ordinalsOf } from "../../src/cstate/store.js";
import { verifyIndexedStores } from "../../src/indexed/verify.js";
import { prepareExpectedScaleWith } from "../../src/scale/transition.js";
import { STATE_FILE } from "../../src/utils/constants.js";
import { readState, readStateClassified, writeState } from "../../src/utils/state.js";
import { CSTATE, indexedWithState, sampleState, stepsFor, useCompileStateProjects } from "./helpers.js";

const projects = useCompileStateProjects();
const roots = projects.roots;

/** An upgraded project. */
const upgraded = async (): Promise<string> => (await projects.upgraded()).root;

/** The cstate verification's problems. */
async function cstateProblems(root: string): Promise<string> {
  return (await verifyIndexedStores(root)).stores.find((store) => store.store === "cstate")?.problems.join("\n") ?? "";
}

describe("routed reads fail closed", () => {
  it("propagate a store fault with its own code, never as a corrupt state.json", async () => {
    const root = await upgraded();
    await writeFile(path.join(root, ".llmwiki", "indexed", "cstate", "manifest.json"), "{}\n");
    await expect(readState(root)).rejects.toMatchObject({ code: "compile_state_unavailable", message: expect.stringMatching(/cannot be read/) as unknown as string });
    await expect(readStateClassified(root)).rejects.toMatchObject({ code: "compile_state_unavailable" });
    expect(existsSync(path.join(root, `${STATE_FILE}.bak`))).toBe(false);
  });

  it("refuse with scale-state-unreadable when the scale record is missing beside the stores", async () => {
    const root = await upgraded();
    await rm(path.join(root, ".llmwiki", "scale.json"));
    await expect(readState(root)).rejects.toMatchObject({ block: "scale-state-unreadable" });
  });
});

describe("source keys", () => {
  it("keep ordinary names and refuse ambiguous or unsafe ones", () => {
    for (const ok of [".notes.md", "my notes.md", "nested/dir/a.md", "café.md"]) expect([ok, isRepresentableSourceKey(ok)]).toEqual([ok, true]);
    for (const bad of ["", "a\0b.md", "a\\b.md", "/abs.md", "a//b.md", "./a.md", "a/../b.md", "..", "__proto__"]) expect([bad, isRepresentableSourceKey(bad)]).toEqual([bad, false]);
  });

  it("refuse a write of an unrepresentable key, and park an import of one", async () => {
    const root = await upgraded();
    const entry = { hash: "h", concepts: [], compiledAt: "2026-10-06T00:00:00.000Z" };
    await expect(writeState(root, { ...(await readState(root)), sources: { "a\\b.md": entry } })).rejects.toMatchObject({ code: "compile_state_unavailable" });
    const fresh = await indexedWithState({ ...sampleState(), sources: { "a\\b.md": entry } });
    roots.push(fresh);
    const parked = await prepareExpectedScaleWith(stepsFor(fresh), { capabilities: [CSTATE] });
    expect(parked.readiness).toBe("preparing");
    expect(JSON.parse(await readFile(path.join(fresh, STATE_FILE), "utf8")).sources).toHaveProperty(["a\\b.md"]);
  });
});

describe("ordinals", () => {
  it("stay within the 12-digit key range: a row beyond it is not a source row, and a write past it is refused", () => {
    expect([isSourceRow({ o: ORDINAL_LIMIT - 1, v: {} }), isSourceRow({ o: ORDINAL_LIMIT, v: {} })]).toEqual([true, false]);
    expect(() => ordinalsOf(sampleState(), new Map(), ORDINAL_LIMIT - 1)).toThrow(/ordinals would pass/);
  });
});

describe("full verification", () => {
  it("refuses two frozen slugs claiming one position", async () => {
    const root = await upgraded();
    const store = await openCompileState(root);
    await store.commit({ rows: [{ k: "z:frozen-two", v: 0 }], meta: { ...store.meta, frozen: 2 } });
    const problems = await cstateProblems(root);
    expect(problems).toMatch(/row z:frozen-two is malformed/);
    expect(problems).toMatch(/frozen-order index holds 1 rows for 2 frozen slugs/);
  });

  it("refuses a row outside the known namespaces", async () => {
    const root = await upgraded();
    await (await openCompileState(root)).commit({ rows: [{ k: "q:stray", v: 1 }] });
    expect(await cstateProblems(root)).toMatch(/outside the compile state's source, order, owner and frozen rows/);
  });

  it("refuses a missing owner row and frozen rows without the frozen list", async () => {
    const root = await upgraded();
    const store = await openCompileState(root);
    // zeta.md is the first source of the sample state: ordinal 0.
    await store.commit({ rows: [{ k: ownerKey("shared", 0), d: 1 }], meta: { ...store.meta, frozenPresent: false } });
    const problems = await cstateProblems(root);
    expect(problems).toMatch(/missing its owner row for shared/);
    expect(problems).toMatch(/records no frozen list, but 1 frozen rows are stored/);
  });
});
