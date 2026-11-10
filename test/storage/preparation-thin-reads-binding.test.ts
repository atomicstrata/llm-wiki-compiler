/**
 * @file test/storage/preparation-thin-reads-binding.test.ts
 * @description Four preparation read-and-decide legs as ONE body each over the
 * reads they make, with no project directory: the workflow-parent verdict
 * (`verifyWorkflowParentFrom`), the gate authority (`resolveGateAuthorityFrom`),
 * the runner's read-back of its materialization (`readManifestBackFrom`,
 * `readPayloadsBackFrom`) and the map and bounded-repeat fan-outs
 * (`driveMapPhaseWith`, `driveRepeatPhaseWith`).
 * This file uses them, which exist only after each was given its reads, so it
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. Each bound body runs over memory answers (a spy standing in
 * for the store's own body, or a logged memory read), so each refusal and its
 * order of reads is pinned, and no incumbent root reader is reached. Each root
 * form is then shown reaching its incumbent root reader with exact arguments,
 * and each composition its store's own body.
 *
 * NOT SHOWN HERE: the stores' own reads and authentication, and the verdicts'
 * full ladders on real disk; the workflow-parent, gate-binding, runner and
 * evidence-store suites show those.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as evidenceStore from "../../src/preparations/evidence-store.js";
import { driveMapPhaseWith, driveRepeatPhase, driveRepeatPhaseWith, fanOutReadsOver, type FanOutReads } from "../../src/preparations/fan-out-driver.js";
import { derivePhaseInstanceId, repeatExpansionIdentity, singleExpansionIdentity } from "../../src/preparations/ids.js";
import { preparationManifestDigest } from "../../src/preparations/manifest-parse.js";
import * as manifestStore from "../../src/preparations/manifest-store.js";
import * as runStore from "../../src/preparations/run-store.js";
import {
  readManifestBack, readPayloadsBackFrom, readManifestBackFrom, runEvidenceBytesOver, type RunEvidenceBytes,
} from "../../src/preparations/runner-reconstruct.js";
import { resolveGateAuthority, resolveGateAuthorityFrom } from "../../src/preparations/service-gate-authority.js";
import { verifyWorkflowParent, verifyWorkflowParentFrom } from "../../src/preparations/workflow-parent.js";
import * as workflowStore from "../../src/workflow-history/store.js";

afterEach(() => { vi.restoreAllMocks(); });

const MANIFEST_DIGEST = `sha256:${"9".repeat(64)}`;
const BINDING = { workspaceId: "ws", preparationId: "prep_1", runId: "run_1", manifestDigest: MANIFEST_DIGEST } as never;
const LOCATION = { workspaceId: "ws", preparationId: "prep_1" };

describe("the workflow-parent verdict over the run store's body", () => {
  const RUN = { workflowId: "build", workflowDigest: "ab".repeat(32), knownStageIds: ["draft"], status: "running", currentStage: "draft" };
  const REF = { workflowRunId: "build-1", workflowId: "build", workflowDigest: `sha256:${"ab".repeat(32)}`, stageId: "draft" } as never;
  const runs = {} as workflowStore.WorkflowRunReads;

  it("W1 answers each read and drift over the store's body, never the root reader", async () => {
    const from = vi.spyOn(workflowStore, "readRunFrom");
    const root = vi.spyOn(workflowStore, "readRun");
    const verdict = async (read: unknown, ref: object = {}) => {
      from.mockResolvedValueOnce(read as never);
      return verifyWorkflowParentFrom(runs, { ...(REF as object), ...ref } as never);
    };
    expect([
      await verdict({ status: "absent" }), await verdict({ status: "unavailable", detail: "integrity" }),
      await verdict({ status: "ok", run: RUN }, { workflowId: "other" }), await verdict({ status: "ok", run: RUN }, { workflowDigest: "ab" }),
      await verdict({ status: "ok", run: RUN }, { stageId: "gone" }), await verdict({ status: "ok", run: RUN }),
    ]).toEqual([
      { status: "absent" }, { status: "unreadable", detail: "integrity" }, { status: "drift", detail: "workflow-id" },
      { status: "drift", detail: "digest" }, { status: "drift", detail: "stage" },
      { status: "verified", workflowId: "build", runStatus: "running", currentStage: "draft", stageId: "draft" },
    ]);
    expect([from.mock.calls.every((call) => call[0] === runs && call[1] === "build-1"), from.mock.calls.length, root.mock.calls]).toEqual([true, 6, []]);
  });

  it("W2 the root form reaches the incumbent root reader with its root and the run id", async () => {
    const from = vi.spyOn(workflowStore, "readRunFrom");
    const root = vi.spyOn(workflowStore, "readRun").mockResolvedValue({ status: "absent" });
    expect(await verifyWorkflowParent("/project", REF)).toEqual({ status: "absent" });
    expect([root.mock.calls, from.mock.calls]).toEqual([[["/project", "build-1"]], []]);
  });
});

describe("the gate authority over the manifest store's body", () => {
  const PLAN_MANIFEST = { plan: { phases: [] } } as never;
  const bound = { ...(BINDING as object), manifestDigest: preparationManifestDigest(PLAN_MANIFEST) } as never;
  const leaves = {} as manifestStore.PreparationManifestLeafReads;

  it("G1 refuses an unreadable manifest, a manifest that drifted from the binding, and an undeclared gate, never the root reader", async () => {
    const from = vi.spyOn(manifestStore, "readPreparationManifestFrom");
    const root = vi.spyOn(manifestStore, "readPreparationManifest");
    const reason = async (read: unknown) => {
      from.mockResolvedValueOnce(read as never);
      const found = await resolveGateAuthorityFrom(leaves, bound, {} as never, "g");
      return found.ok ? found : found.reason;
    };
    expect([
      await reason({ status: "absent" }),
      await reason({ status: "ok", manifest: { plan: { phases: [{}] } } }),
      await reason({ status: "ok", manifest: PLAN_MANIFEST }),
    ]).toEqual([
      "the run's manifest is absent",
      "the run's manifest digest changed; this is no longer the plan the run was staged against",
      'this run\'s plan declares no gate named "g"',
    ]);
    expect([from.mock.calls, root.mock.calls]).toEqual([Array(3).fill([leaves, "ws", "prep_1"]), []]);
  });

  it("G2 the root form reaches the incumbent root reader with its root and the binding's ids", async () => {
    const from = vi.spyOn(manifestStore, "readPreparationManifestFrom");
    const root = vi.spyOn(manifestStore, "readPreparationManifest").mockResolvedValue({ status: "absent" });
    expect(await resolveGateAuthority("/project", bound, {} as never, "g")).toEqual({ ok: false, reason: "the run's manifest is absent" });
    expect([root.mock.calls, from.mock.calls]).toEqual([[["/project", "ws", "prep_1"]], []]);
  });
});

/** A logged memory evidence read answering `held` by bare digest; anything else is absent. */
function evidenceOf(log: string[], held: Record<string, Buffer>): RunEvidenceBytes {
  return async (digest, maxBytes) => {
    log.push(`evidence ${digest} ${maxBytes}`);
    return digest in held ? { status: "ok", bytes: held[digest]! } : { status: "absent" };
  };
}

describe("the runner's read-back over the run's evidence read", () => {
  it("R1 strips the prefix before reading the manifest, and names an absent or unparseable one", async () => {
    const log: string[] = [];
    const evidence = evidenceOf(log, { bad: Buffer.from("{") });
    expect(await readManifestBackFrom(evidence, "sha256:gone", 7)).toBe("manifest evidence absent");
    expect(await readManifestBackFrom(evidence, "bad", 7)).toMatch(/^manifest unparseable: /);
    expect(log).toEqual(["evidence gone 7", "evidence bad 7"]);
  });

  it("R2 reads each payload in manifest order and stops at the first refusal", async () => {
    const log: string[] = [];
    const evidence = evidenceOf(log, { a: Buffer.from("A"), c: Buffer.from("C") });
    const body = (...digests: string[]) => ({ payloadRefs: digests.map((digest) => ({ digest })) }) as never;
    expect(await readPayloadsBackFrom(evidence, body("a", "c"), 3)).toEqual(new Map([["a", Buffer.from("A")], ["c", Buffer.from("C")]]));
    expect(await readPayloadsBackFrom(evidence, body("a", "b", "c"), 3)).toBe("payload b absent");
    expect(log).toEqual(["evidence a 3", "evidence c 3", "evidence a 3", "evidence b 3"]);
  });

  it("R3 the composition asks the evidence store's body; the root form the incumbent root reader, at the run's location", async () => {
    const from = vi.spyOn(evidenceStore, "readPreparationEvidenceBytesFrom").mockResolvedValue({ status: "absent" });
    const root = vi.spyOn(evidenceStore, "readPreparationEvidenceBytes").mockResolvedValue({ status: "absent" });
    const leaves = {} as evidenceStore.PreparationEvidenceLeafReads;
    expect(await runEvidenceBytesOver(leaves, BINDING)("d", 5)).toEqual({ status: "absent" });
    expect(await readManifestBack({ root: "/project", binding: BINDING } as never, "sha256:d", 7)).toBe("manifest evidence absent");
    expect([from.mock.calls, root.mock.calls]).toEqual([[[leaves, LOCATION, "d", 5]], [["/project", LOCATION, "d", 7]]]);
  });
});

describe("the bounded-repeat fan-out over its two reads", () => {
  /** The cap the fan-out states for one decoded evidence object. */
  const SOURCE_CAP = 4 * 1024 * 1024;
  const PHASE = { logicalPhaseId: "loop", inputBindings: [] } as never;
  const UNTIL_EMPTY = { kind: "bounded-repeat", maximumIterations: 3, continuation: { kind: "until-empty" }, limitDisposition: { kind: "fail-closed" } } as never;
  const FIRST = derivePhaseInstanceId({ manifestDigest: MANIFEST_DIGEST, logicalPhaseId: "loop", expansionIdentity: repeatExpansionIdentity(0) });
  const ranOnce = { status: "ok", run: { phaseSummaries: [{ phaseInstanceId: FIRST, outputEvidenceDigest: "sha256:ab" }] } };

  /** Drive the phase over logged memory reads answering `run` and `held`; the outcome and every call. */
  async function drive(run: unknown, held: Record<string, Buffer> = { ab: Buffer.from("[]") }): Promise<[unknown, string[]]> {
    const log: string[] = [];
    const reads: FanOutReads = { readRun: async () => { log.push("run"); return run as never; }, evidenceBytes: evidenceOf(log, held) };
    const input = { binding: BINDING, decodeExpansionItems: (id: string) => { log.push(`decode ${id}`); return []; } };
    const outcome = await driveRepeatPhaseWith(reads, input, PHASE, UNTIL_EMPTY, async (id, identity) => { log.push(`drive ${id} ${identity}`); return null; });
    return [outcome === null ? null : (outcome as { reason: string }).reason, log];
  }

  it("F1 drives one iteration, reads the run then its output evidence, decodes it empty, and converges, never the root readers", async () => {
    const roots = [vi.spyOn(runStore, "readPreparationRun"), vi.spyOn(evidenceStore, "readPreparationEvidenceBytes")];
    expect(await drive(ranOnce)).toEqual([null, [`drive loop ${repeatExpansionIdentity(0)}`, "run", `evidence ab ${SOURCE_CAP}`, "decode loop"]]);
    expect(roots.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
  });

  it("F2 refuses an unreadable run, an instance with no output, and absent evidence, each before decoding", async () => {
    const reasons = [
      await drive({ status: "unavailable" }), await drive({ status: "ok", run: { phaseSummaries: [] } }), await drive(ranOnce, {}),
    ].map(([reason]) => reason);
    expect(reasons).toEqual(["run unreadable", "phase loop produced no output evidence", "source evidence absent"]);
  });

  it("F3 the composition asks each store's body at the binding; the root form the incumbent root readers with exact arguments", async () => {
    const runFrom = vi.spyOn(runStore, "readPreparationRunFrom").mockResolvedValue(ranOnce as never);
    const bytesFrom = vi.spyOn(evidenceStore, "readPreparationEvidenceBytesFrom").mockResolvedValue({ status: "absent" });
    const sources = { runs: {} as runStore.PreparationRunLeafReads, evidence: {} as evidenceStore.PreparationEvidenceLeafReads };
    const over = fanOutReadsOver(sources, BINDING);
    await over.readRun();
    await over.evidenceBytes("ab", 9);
    expect([runFrom.mock.calls, bytesFrom.mock.calls]).toEqual([[[sources.runs, BINDING]], [[sources.evidence, LOCATION, "ab", 9]]]);
    const run = vi.spyOn(runStore, "readPreparationRun").mockResolvedValue(ranOnce as never);
    const bytes = vi.spyOn(evidenceStore, "readPreparationEvidenceBytes").mockResolvedValue({ status: "ok", bytes: Buffer.from("[]") });
    const input = { root: "/project", binding: BINDING, decodeExpansionItems: () => [] } as never;
    expect(await driveRepeatPhase(input, PHASE, UNTIL_EMPTY, async () => null)).toBeNull();
    expect([run.mock.calls, bytes.mock.calls]).toEqual([[["/project", BINDING]], [["/project", LOCATION, "ab", SOURCE_CAP]]]);
  });
});

describe("the map fan-out over the same two reads", () => {
  const SOURCE = derivePhaseInstanceId({ manifestDigest: MANIFEST_DIGEST, logicalPhaseId: "src", expansionIdentity: singleExpansionIdentity() });
  const PHASE = { logicalPhaseId: "fan", inputBindings: [{ bindingId: "items", sourcePhaseId: "src" }] } as never;
  const MAP = { kind: "map", sourceEvidenceBinding: "items", maximumItems: 4, itemIdentity: "canonical-item-digest", duplicateDisposition: "deduplicate", overflowDisposition: { kind: "fail-closed" } } as const;
  const SOURCED = { status: "ok", run: { phaseSummaries: [{ phaseInstanceId: SOURCE, outputEvidenceDigest: "sha256:ab" }] } };

  /** Drive the map over logged memory reads; `decoder: false` leaves the pack's decoder out. */
  async function mapOver(options: { phase?: unknown; expansion?: object; decoder?: false } = {}): Promise<[unknown, string[]]> {
    const log: string[] = [];
    const reads: FanOutReads = { readRun: async () => { log.push("run"); return SOURCED as never; }, evidenceBytes: evidenceOf(log, { ab: Buffer.from("[]") }) };
    const decode = (id: string) => { log.push(`decode ${id}`); return ["a", "b", "a"]; };
    const input = { binding: BINDING, ...(options.decoder === false ? {} : { decodeExpansionItems: decode }) };
    const outcome = await driveMapPhaseWith(reads, input, (options.phase ?? PHASE) as never, { ...MAP, ...options.expansion } as never,
      async (id, identity) => { log.push(`drive ${id} ${identity.split(":")[0]}`); return null; });
    return [outcome === null ? null : (outcome as { reason: string }).reason, log];
  }

  it("M1 reads the source run then its evidence, decodes it, and drives each de-duplicated item in first-seen order", async () => {
    const drive = "drive fan map-canonical-item-digest";
    expect(await mapOver()).toEqual([null, ["run", `evidence ab ${4 * 1024 * 1024}`, "decode fan", drive, drive]]);
  });

  it("M2 refuses a missing decoder and an unbound source binding before any read, and a refused enumeration before any drive", async () => {
    expect(await mapOver({ decoder: false })).toEqual(["map phase fan needs an item decoder", []]);
    expect(await mapOver({ phase: { logicalPhaseId: "fan", inputBindings: [] } })).toEqual(["map source binding items is unbound", []]);
    expect(await mapOver({ expansion: { maximumItems: 1 } }))
      .toEqual(["fan-out of fan: fan-out of 2 exceeds the 1 cap (fail-closed)", ["run", `evidence ab ${4 * 1024 * 1024}`, "decode fan"]]);
  });
});
