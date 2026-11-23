/**
 * @file test/scale/preview.test.ts
 * @description The read-only transition preview on real disk reports what
 * `scale set` would do, from the same planning body, and writes nothing: a
 * larger estimate on a new project prepares `local-large` with its steps and
 * free-space requirement; a smaller estimate keeps the larger active layout
 * (`none`: lowering is never a scale-down); requesting the segmented compile
 * state on an active indexed project is a `capability-upgrade` with its
 * steps, and so is an upgrade an interruption left with the capability still
 * preparing; an unknown capability refuses exactly as `set` does; and a
 * scale-down in progress refuses as it does for `set`.
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import type { CapabilityNameV3, ScaleRecordV2 } from "../../src/scale/contracts-v2.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { previewScaleTransition } from "../../src/scale/preview.js";
import { readScaleRecord } from "../../src/scale/record.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../src/scale/transition.js";
import { activateIndexed, writeCorpus } from "../catalog/helpers.js";
import { refusal } from "./memory-steps.js";

/** An in-process indexed activation is several durable commits; measured over the 30-second default on the shared test volume. */
const ACTIVATION_CASE_TIMEOUT_MS = 300_000;
const AMPLE = { freeBytes: async () => Number.MAX_SAFE_INTEGER };

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-scale-preview-")); await writeCorpus(root, 2, 2); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the transition preview", () => {
  it("previews a local-large preparation with its steps and space, writing nothing", async () => {
    const preview = await previewScaleTransition(root, { documents: 2_000 }, [], AMPLE);
    expect([preview.change, preview.steps, preview.preflight?.freeBytes]).toEqual(["prepare", ["capacity-preflight", "embedding-container"], Number.MAX_SAFE_INTEGER]);
    expect(preview.measured).toMatchObject({ sourceDocuments: 2 });
    expect(await readdir(root)).not.toContain(".llmwiki");
  });

  it("keeps a larger active layout for a smaller estimate", async () => {
    await setExpectedScaleWith({ ...diskScaleTransitionSteps(root), preflight: AMPLE }, { request: { documents: 2_000 } });
    const preview = await previewScaleTransition(root, { documents: 100 }, [], AMPLE);
    expect([preview.change, preview.steps, preview.next.active.architecture]).toEqual(["none", [], "local-large"]);
  });

  it("refuses an unknown capability exactly as set does", async () => {
    expect(await refusal(previewScaleTransition(root, { documents: 100 }, ["future-1" as CapabilityNameV3], AMPLE))).toBe("scale_invalid_request");
  });

  it("previews a capability upgrade of an active indexed project, and refuses during a scale-down", async () => {
    await activateIndexed(root);
    const preview = await previewScaleTransition(root, { documents: 8_000 }, ["segmented-compile-state-1"], AMPLE);
    expect([preview.change, preview.steps, preview.capabilities]).toEqual(["capability-upgrade", ["segmented-compile-state-1", "activation-verify"], ["segmented-compile-state-1"]]);
    const read = await readScaleRecord(root);
    const current = (read as { record: ScaleRecordV2 }).record;
    // An upgrade interrupted with the capability still preparing: set would prepare it again, so preview says so.
    await writeFile(path.join(root, ".llmwiki", "scale.json"), serializeAnyScaleRecord({ ...current, version: 3, capabilities: [{ name: "segmented-compile-state-1", status: "preparing" }] }));
    const resumed = await previewScaleTransition(root, { documents: 8_000 }, [], AMPLE);
    expect([resumed.change, resumed.steps, resumed.preflight]).toEqual(["capability-upgrade", ["segmented-compile-state-1", "activation-verify"], null]);
    const fenced = { ...current, revision: current.revision + 1, pending: { kind: "downgrade", revision: current.revision + 1, target: "local-standard", plan: "e".repeat(64) } };
    await writeFile(path.join(root, ".llmwiki", "scale.json"), serializeAnyScaleRecord({ ...fenced, requested: planScaleV2({ documents: 100 }).requested } as ScaleRecordV2));
    expect(await refusal(previewScaleTransition(root, { documents: 100 }, [], AMPLE))).toBe("scale_downgrade_pending");
  }, ACTIVATION_CASE_TIMEOUT_MS);
});
