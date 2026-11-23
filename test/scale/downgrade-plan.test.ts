/**
 * @file test/scale/downgrade-plan.test.ts
 * @description The plan and preflight integrity of a scale-down, in process:
 *
 * - a counting export past its file's incumbent cap is reported with its real
 *   size AND as an `export_too_large` blocker (witnessed with a reduced cap);
 * - a known regular file the freeze cannot read whole (a hard-linked source)
 *   is `content_unreadable`, never left out of the measurement;
 * - a missing or foreign scale-down target refuses before any read;
 * - a plan round trips; a plan for another root, an edited body, and a
 *   re-digested body with a malformed nested field or a unit path that is not
 *   its kind's incumbent path are each `scale_downgrade_invalid_plan`.
 */

import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { appendEvent } from "../../src/events/store.js";
import { freezeContent } from "../../src/scale/downgrade-freeze.js";
import { buildDowngradePlan, parseDowngradePlan, serializeDowngradePlan, type DowngradePlanV1 } from "../../src/scale/downgrade-plan.js";
import { ExportSink } from "../../src/scale/downgrade-sink.js";
import { runExports } from "../../src/scale/downgrade-units.js";
import { previewScaleDowngrade } from "../../src/scale/preview.js";
import { diskScaleTransitionSteps, setExpectedScaleWith } from "../../src/scale/transition.js";
import { activateIndexed, writeCorpus } from "../catalog/helpers.js";
import { refusal } from "./memory-steps.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), "llmwiki-downgrade-plan-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const AMPLE = { freeBytes: async () => Number.MAX_SAFE_INTEGER };
/**
 * An in-process indexed activation is several durable commits; on the shared
 * private test volume it has exceeded the 30-second default (measured), so
 * the one case that activates gets this bound.
 */
const ACTIVATION_CASE_TIMEOUT_MS = 300_000;

/** A valid plan of a local-large project scaling down to local-standard. */
async function largePlan(): Promise<DowngradePlanV1> {
  await writeCorpus(root, 2, 2);
  await setExpectedScaleWith({ ...diskScaleTransitionSteps(root), preflight: AMPLE }, { request: { documents: 2_000 } });
  return (await previewScaleDowngrade(root, { target: "local-standard", request: { documents: 100 } }, AMPLE)).plan;
}

/** The refusal code of parsing `text`. */
function parseCode(text: string, at = root): string {
  try { parseDowngradePlan(text, at); return "parsed"; } catch (error) { return (error as { code?: string }).code ?? String(error); }
}

describe("preflight blockers", () => {
  it("reports an export past its incumbent cap with its real size and as a blocker", async () => {
    for (let n = 0; n < 3; n += 1) await appendEvent(root, { type: "connector-fetch", origin: `o${n}`, payload: {}, at: "2026-10-30T00:00:00.000Z" });
    await activateIndexed(root);
    const reduced = await runExports(root, { workspaces: [], segmentedState: false }, (relPath) => new ExportSink(relPath, 50));
    const events = reduced.units.find((unit) => unit.kind === "events")!;
    expect(events.bytes).toBeGreaterThan(50);
    expect(reduced.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "export_too_large", detail: expect.stringContaining("wiki/graph/events.jsonl") })]));
  }, ACTIVATION_CASE_TIMEOUT_MS);

  it("makes a known regular file it cannot read whole content_unreadable", async () => {
    await mkdir(path.join(root, "sources"));
    await writeFile(path.join(root, "sources", "a.md"), "# A\n");
    await link(path.join(root, "sources", "a.md"), path.join(root, "sources", "b.md"));
    await expect(freezeContent(root, new Set())).rejects.toMatchObject({ code: "content_unreadable" });
  });
});

describe("the scale-down target", () => {
  it("refuses a missing or foreign target before any read, writing nothing", async () => {
    for (const target of [undefined, "local-indexed", "elsewhere"]) {
      expect(await refusal(previewScaleDowngrade(`${root}/absent`, { target: target as never, request: { documents: 100 } }, AMPLE))).toBe("scale_invalid_request");
    }
  });
});

describe("strict plan parsing", () => {
  it("round trips, and refuses another root and an edited body", async () => {
    const plan = await largePlan();
    expect(parseDowngradePlan(serializeDowngradePlan(plan), root)).toEqual(plan);
    expect(parseCode(serializeDowngradePlan(plan), `${root}-other`)).toBe("scale_downgrade_invalid_plan");
    const edited = { ...plan, inventory: { ...plan.inventory, lastRun: "abcdefabcdef" } };
    expect(parseCode(JSON.stringify(edited))).toBe("scale_downgrade_invalid_plan");
  });

  it("refuses a re-digested body with a malformed nested field or a foreign unit path", async () => {
    const plan = await largePlan();
    /** The plan text of `inventory`, digest recomputed (so only the schema can refuse it). */
    const redigested = (inventory: unknown) => JSON.stringify(buildDowngradePlan(root, inventory as DowngradePlanV1["inventory"]));
    expect(parseCode(redigested({ ...plan.inventory, measured: { ...plan.inventory.measured, sourceBytes: -1 } }))).toBe("scale_downgrade_invalid_plan");
    expect(parseCode(redigested({ ...plan.inventory, runs: "none" }))).toBe("scale_downgrade_invalid_plan");
    const foreign = { kind: "events", relPath: "../outside.jsonl", present: true, bytes: 1, sha256: "a".repeat(64), records: 1 };
    expect(parseCode(redigested({ ...plan.inventory, units: [foreign], priors: [] }))).toBe("scale_downgrade_invalid_plan");
  });
});
