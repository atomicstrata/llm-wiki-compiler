/**
 * @file test/cstate/cstate-upgrade.test.ts
 * @description The `segmented-compile-state-1` capability on real disk,
 * through the real scale bodies:
 * - an UPGRADE of an active indexed project (`scale prepare` with the
 *   capability): the record holds the capability `preparing` BEFORE the store
 *   exists (status `preparing`, the gate blocks), then `state.json` is
 *   imported, verified and the capability published `ready`; the state reads
 *   back equal in its insertion order (an unsorted witness), a slug's owners
 *   stream in incumbent owner order, and `state.json` is never written;
 * - a FIRST preparation that requests it imports during the history step;
 * - routed narrow and whole writes reach the store, never `state.json`;
 * - a changed `state.json` refuses writes and fails verification;
 * - `llmwiki state reset` refuses on a segmented root.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { resetStateFileWith } from "../../src/commands/state-reset.js";
import { compileStateSegmented } from "../../src/cstate/records.js";
import { ownersPrefix } from "../../src/cstate/contracts.js";
import { openCompileState } from "../../src/cstate/store.js";
import { verifyIndexedStores } from "../../src/indexed/verify.js";
import { scaleGateRefusal } from "../../src/scale/gate.js";
import { diskScaleRecordIo } from "../../src/scale/record.js";
import { prepareExpectedScaleWith, scaleStatusFrom, setExpectedScaleWith } from "../../src/scale/transition.js";
import { STATE_FILE } from "../../src/utils/constants.js";
import { readState, removeSourceState, updateSourceState, writeState } from "../../src/utils/state.js";
import { writeCorpus } from "../catalog/helpers.js";
import { resolveStorageTestProfile } from "../config/storage-test-profile.js";
import { CSTATE, indexedWithState, sampleState, stepsFor, useCompileStateProjects } from "./helpers.js";

const { roots, upgraded } = useCompileStateProjects();

/**
 * The routed-writes case's own budget under the explicit `slow-durable-storage`
 * profile: its real upgraded fixture (about 234 s of durable setup on slow
 * external storage) plus five sequential durable commits exceed that profile's
 * 300 s. A functional allowance for slow storage only, never a reference budget.
 */
const ROUTED_WRITES_SLOW_STORAGE_TIMEOUT_MS = 600_000;

/** That budget when slow storage is selected; otherwise undefined, so the helper's file budget applies. */
const routedWritesTimeoutMs = resolveStorageTestProfile(process.env.LLMWIKI_TEST_STORAGE_PROFILE).profile === "slow-durable-storage"
  ? ROUTED_WRITES_SLOW_STORAGE_TIMEOUT_MS
  : undefined;

describe("the upgrade of an active indexed project", () => {
  it("fences with preparing before the store exists, imports, verifies and publishes ready", async () => {
    const root = await indexedWithState();
    roots.push(root);
    const seen: unknown[] = [];
    const checkpoint = async () => { seen.push((await scaleStatusFrom(diskScaleRecordIo(root))).readiness, (await scaleGateRefusal(root))?.block, (await openCompileState(root)).exists); };
    const report = await prepareExpectedScaleWith(stepsFor(root, checkpoint), { capabilities: [CSTATE] });
    expect(seen).toEqual(["preparing", "scale-transition-pending", false]);
    expect([report.readiness, report.record?.version === 1 ? [] : report.record?.capabilities]).toEqual(["ready", [{ name: CSTATE, status: "ready" }]]);
    expect((await verifyIndexedStores(root)).ok).toBe(true);
  });

  it("reads back the same state in its INSERTION order, owners in incumbent order, and never writes state.json", async () => {
    const { root, legacy } = await upgraded();
    const state = await readState(root);
    expect(state).toEqual(sampleState());
    expect(Object.keys(state.sources)).toEqual(["zeta.md", ".notes.md", "my notes.md"]);
    const owners: unknown[] = [];
    for await (const row of (await openCompileState(root)).scan({ prefix: ownersPrefix("shared") })) owners.push(row.v);
    expect(owners).toEqual(["zeta.md", ".notes.md"]);
    expect((await readFile(path.join(root, STATE_FILE))).equals(legacy)).toBe(true);
  });
});

describe("a first preparation that requests the capability", () => {
  it("imports the compile state during the history step and activates it ready", async () => {
    const fresh = await mkdtemp(path.join(tmpdir(), "llmwiki-cstate-first-"));
    roots.push(fresh);
    await writeCorpus(fresh, 2, 1);
    await writeState(fresh, sampleState());
    const report = await setExpectedScaleWith(stepsFor(fresh), { request: { documents: 8_000 }, capabilities: [CSTATE] });
    expect([report.readiness, report.record?.active.architecture, report.record?.version === 1 ? [] : report.record?.capabilities]).toEqual(["ready", "local-indexed", [{ name: CSTATE, status: "ready" }]]);
    expect([(await openCompileState(fresh)).exists, await readState(fresh)]).toEqual([true, sampleState()]);
  });
});

describe("routed writes", () => {
  it("reach the store for narrow and whole writes; state.json stays the untouched backup", async () => {
    const { root, legacy } = await upgraded();
    await updateSourceState(root, "new.md", { hash: "h-new", concepts: ["shared", "fresh"], compiledAt: "2026-10-05T00:00:00.000Z" });
    await removeSourceState(root, "zeta.md");
    await writeState(root, { ...(await readState(root)), frozenSlugs: [], promptModifiers: "pm-2" });
    const state = await readState(root);
    expect([Object.keys(state.sources), state.frozenSlugs, state.promptModifiers]).toEqual([[".notes.md", "my notes.md", "new.md"], [], "pm-2"]);
    // A rewritten entry keeps its place; a removed and re-added source moves to the end, as the incumbent object does.
    await updateSourceState(root, ".notes.md", { hash: "h-n2", concepts: ["shared"], compiledAt: "2026-10-07T00:00:00.000Z" });
    await updateSourceState(root, "zeta.md", { hash: "h-z2", concepts: ["shared"], compiledAt: "2026-10-07T00:00:00.000Z" });
    expect(Object.keys((await readState(root)).sources)).toEqual([".notes.md", "my notes.md", "new.md", "zeta.md"]);
    expect((await readFile(path.join(root, STATE_FILE))).equals(legacy)).toBe(true);
    expect((await verifyIndexedStores(root)).ok).toBe(true);
  }, routedWritesTimeoutMs);

  it("refuse once state.json changed after the import, and verification reports the drift", async () => {
    const { root } = await upgraded();
    await writeFile(path.join(root, STATE_FILE), JSON.stringify({ ...sampleState(), indexHash: "edited" }));
    await expect(updateSourceState(root, "x.md", { hash: "h", concepts: [], compiledAt: "2026-10-06T00:00:00.000Z" })).rejects.toMatchObject({ code: "compile_state_legacy_changed" });
    const report = await verifyIndexedStores(root);
    expect(report.stores.find((store) => store.store === "cstate")?.problems.join("\n")).toMatch(/changed after it was imported/);
  });
});

describe("state reset", () => {
  it("refuses on a segmented root and leaves state.json and the store in place", async () => {
    const { root, legacy } = await upgraded();
    const notices: string[] = [];
    const steps = { realLlmwikiDir: async () => path.join(root, ".llmwiki"), realRoot: async () => root, acquireLock: async () => true, releaseLock: async () => {}, notice: (code: string) => { notices.push(code); }, segmented: () => compileStateSegmented(root) };
    await resetStateFileWith(steps as unknown as Parameters<typeof resetStateFileWith>[0]);
    expect(notices).toEqual(["segmented"]);
    expect((await readFile(path.join(root, STATE_FILE))).equals(legacy)).toBe(true);
  });
});
