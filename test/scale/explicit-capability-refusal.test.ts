/**
 * @file test/scale/explicit-capability-refusal.test.ts
 * @description An explicitly requested capability must be HELD by the record
 * a scale command would actually store or act on (SCALE-3): requesting one
 * never changes the layout, and it is never silently ignored.
 *
 * CORE (root-free `memorySteps`, an in-memory record with a write counter and
 * a logged fake lock): `set` at 100 and 2,000 documents (new and active-large
 * projects), `prepare` on an absent record, a ready non-indexed record, a
 * deferred 2,000-document preparation and an unavailable estimate, and an
 * INELIGIBLE 8,000-document plan, each requesting `segmented-compile-state-1`,
 * must refuse `scale_invalid_request` naming the capability and its
 * local-indexed prerequisite, write nothing, run no preparation step, and
 * release the lock. Controls: an active indexed project with a lowered
 * estimate and an eligible 8,000-document plan hold the capability
 * `preparing` (never ready early); an already-held capability changes
 * nothing; an implicit profile capability and an empty explicit list behave
 * as before.
 *
 * DISK: the read-only preview refuses the same requests on a fresh project
 * (writing nothing) and still previews a `capability-upgrade` on an active
 * indexed record; the SDK `wiki.scale.set` refuses with the same code.
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * (the `test/portable/scale-first-open.test.ts` seam) for the disk raw lock;
 * no native start-time probe runs.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import type { CapabilityNameV3, ScaleRecord } from "../../src/scale/contracts-v2.js";
import { planScaleV2 } from "../../src/scale/plan-v2.js";
import { previewScaleTransition } from "../../src/scale/preview.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import { prepareExpectedScaleWith, setExpectedScaleWith, type ScaleTransitionSteps } from "../../src/scale/transition.js";
import { buildScaleFacade } from "../../src/sdk/scale-facade.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { ownPidOwnerSeamPerTest, privateRoots } from "../fixtures/scoped-test-roots.js";
import { memorySteps, type Memory } from "./memory-steps.js";

const CAP: CapabilityNameV3 = "segmented-compile-state-1";
const AMPLE = { freeBytes: async () => Number.MAX_SAFE_INTEGER };
const { privateDir, cleanup } = privateRoots("llmwiki-capability-");

ownPidOwnerSeamPerTest();
afterAll(cleanup);

/** A ready record whose ACTIVE layout is `architecture` (the version that layout is written in). */
function activeRecord(architecture: "local-large" | "local-indexed", documents: number, extra: Partial<ScaleRecord> = {}): string {
  const requested = planScaleV2({ documents }).requested;
  const active = { architecture, sinceRevision: 1 };
  const base = architecture === "local-large" ? { version: 1, revision: 1, requested, active, pending: null } : { version: 2, policy: "local-v2", revision: 1, requested, active, pending: null };
  return serializeAnyScaleRecord({ ...base, ...extra } as ScaleRecord);
}

/** An in-memory project holding `text`, its steps, and the indexed or implicit inputs a case states. */
function project(text: string | null = null, options: Partial<ScaleTransitionSteps> = {}): { memory: Memory; steps: ScaleTransitionSteps } {
  const memory: Memory = { text, writes: 0, log: [], free: Number.MAX_SAFE_INTEGER };
  return { memory, steps: { ...memorySteps(memory), ...options } };
}

/** The refusal of `work`: its code and message (`resolved` when it did not refuse). */
async function refusalOf(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  return work.then(() => ({ code: "resolved", message: "" }), (error: { code?: string; message?: string }) => ({ code: error.code ?? String(error), message: error.message ?? "" }));
}

/** Require the typed refusal naming the capability and its prerequisite, with nothing written and the lock released. */
async function expectRefusedUnchanged(state: { memory: Memory }, work: Promise<unknown>): Promise<void> {
  const before = { text: state.memory.text, writes: state.memory.writes };
  const refused = await refusalOf(work);
  expect(refused.code).toBe("scale_invalid_request");
  expect(refused.message).toContain(CAP);
  expect(refused.message).toContain("local-indexed");
  expect({ text: state.memory.text, writes: state.memory.writes }).toEqual(before);
  expect(state.memory.log.at(-1)).toBe("release");
}

describe("an explicit capability a resulting layout cannot hold refuses before any write", () => {
  for (const documents of [100, 2_000]) {
    it(`set on a new project at ${documents} documents`, async () => {
      const state = project();
      await expectRefusedUnchanged(state, setExpectedScaleWith(state.steps, { request: { documents }, capabilities: [CAP], prepare: false }));
    });
  }

  it("set at 2,000 documents on an active large project", async () => {
    const state = project(activeRecord("local-large", 2_000));
    await expectRefusedUnchanged(state, setExpectedScaleWith(state.steps, { request: { documents: 2_000 }, capabilities: [CAP], prepare: false }));
  });

  it("set on an ineligible 8,000-document plan never records it unavailable instead", async () => {
    const state = project(null, { eligibility: async () => ["profile-entity-catalog"] });
    await expectRefusedUnchanged(state, setExpectedScaleWith(state.steps, { request: { documents: 8_000 }, capabilities: [CAP], prepare: false }));
  });

  it("prepare on an absent record and on a ready non-indexed record", async () => {
    const absent = project();
    await expectRefusedUnchanged(absent, prepareExpectedScaleWith(absent.steps, { capabilities: [CAP] }));
    const ready = project();
    await setExpectedScaleWith(ready.steps, { request: { documents: 100 } });
    await expectRefusedUnchanged(ready, prepareExpectedScaleWith(ready.steps, { capabilities: [CAP] }));
  });

  it("prepare on a deferred 2,000-document preparation runs no step", async () => {
    const state = project();
    await setExpectedScaleWith(state.steps, { request: { documents: 2_000 }, prepare: false });
    await expectRefusedUnchanged(state, prepareExpectedScaleWith(state.steps, { capabilities: [CAP] }));
    expect(JSON.parse(state.memory.text!).pending.steps.map((step: { status: string }) => step.status)).toEqual(["pending", "pending"]);
  });

  it("prepare on an unavailable estimate stays blocked instead of ignoring the request", async () => {
    const state = project(null, { eligibility: async () => ["profile-entity-catalog"] });
    await setExpectedScaleWith(state.steps, { request: { documents: 8_000 }, prepare: false });
    await expectRefusedUnchanged(state, prepareExpectedScaleWith(state.steps, { capabilities: [CAP] }));
  });
});

describe("a layout that can hold the capability still records it preparing", () => {
  it("an active indexed project keeps its layout under a lowered estimate", async () => {
    const state = project(activeRecord("local-indexed", 8_000));
    const report = await setExpectedScaleWith(state.steps, { request: { documents: 100 }, capabilities: [CAP], prepare: false });
    expect(report).toMatchObject({ readiness: "preparing", record: { version: 3, active: { architecture: "local-indexed" }, pending: null, capabilities: [{ name: CAP, status: "preparing" }] } });
  });

  it("an eligible 8,000-document plan prepares local-indexed holding the capability", async () => {
    const state = project();
    const report = await setExpectedScaleWith(state.steps, { request: { documents: 8_000 }, capabilities: [CAP], prepare: false });
    expect(report.record).toMatchObject({ version: 3, pending: { kind: "prepare", target: "local-indexed" }, capabilities: [{ name: CAP, status: "preparing" }] });
  });

  it("an already-held capability changes nothing on prepare", async () => {
    const state = project(activeRecord("local-indexed", 8_000, { version: 3, capabilities: [{ name: CAP, status: "ready" }] } as Partial<ScaleRecord>));
    const report = await prepareExpectedScaleWith(state.steps, { capabilities: [CAP] });
    expect([report.readiness, state.memory.writes]).toEqual(["ready", 0]);
  });

  it("implicit profile capabilities and an empty explicit list behave as before", async () => {
    const implicit = { capabilities: async (): Promise<CapabilityNameV3[]> => ["typed-entity-catalog-1"] };
    const small = project(null, implicit);
    expect((await setExpectedScaleWith(small.steps, { request: { documents: 100 }, capabilities: [] })).record).toMatchObject({ version: 1, pending: null });
    const indexed = project(null, implicit);
    const report = await setExpectedScaleWith(indexed.steps, { request: { documents: 8_000 }, prepare: false });
    expect(report.record).toMatchObject({ capabilities: [{ name: "typed-entity-catalog-1", status: "preparing" }] });
  });
});

describe("the disk preview and the SDK", () => {
  /** A new private project root. */
  function freshRoot(): Promise<string> {
    return privateDir();
  }

  for (const documents of [100, 2_000]) {
    it(`preview refuses at ${documents} documents on a new project and writes nothing`, async () => {
      const root = await freshRoot();
      const refused = await refusalOf(previewScaleTransition(root, { documents }, [CAP], AMPLE));
      expect([refused.code, await readdir(root)]).toEqual(["scale_invalid_request", []]);
    });
  }

  it("preview still reports a capability upgrade on an active indexed record", async () => {
    const root = await freshRoot();
    await mkdir(path.join(root, ".llmwiki"));
    await writeFile(path.join(root, ".llmwiki", "scale.json"), activeRecord("local-indexed", 8_000));
    const preview = await previewScaleTransition(root, { documents: 100 }, [CAP], AMPLE);
    expect([preview.change, preview.next.active.architecture, preview.capabilities]).toEqual(["capability-upgrade", "local-indexed", [CAP]]);
  });

  it("the SDK set refuses with the same code and writes no record", async () => {
    const root = await freshRoot();
    const sdk = buildScaleFacade(root, (fn) => fn());
    expect((await refusalOf(sdk.set({ documents: 100, prepare: false, capabilities: [CAP] }))).code).toBe("scale_invalid_request");
    expect(await readdir(path.join(root, ".llmwiki")).catch(() => [])).not.toContain("scale.json");
    expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
  });
});
