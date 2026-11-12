/**
 * @file test/storage/operation-cli-binding.test.ts
 * @description The `operation cancel`, `inspect` and `list` controllers as ONE
 * body each over their project steps (`operationCancelCommandWith`,
 * `operationInspectCommandWith`, `operationListCommandWith`), with no project.
 * This file uses the bodies, which exist only after the controllers were given
 * their steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Memory steps answer resolution, the advisory write and read,
 * the clock, the inventory, the key, each run and the recovery state, and log each
 * call, so every decision is pinned with the steps it reached: the resolution
 * refusal, the cancellable-state refusal, the advisory keyed on the RESOLVED
 * identity, and each list row's meaning. Output is captured from stdout and
 * stderr. The compositions are shown reaching the resolution and recovery bodies,
 * and each root form the incumbents with its root.
 *
 * NOT SHOWN HERE: target resolution's own rules, the advisory store and the
 * recovery classification; the consumer-closure, cancel-request and lock-gate
 * suites show those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { CLI_OPERATOR_ID } from "../../src/cli/shared.js";
import * as bundleTarget from "../../src/operation-bundles/bundle-target.js";
import * as cancelRequest from "../../src/operation-bundles/cancel-request.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { operationCancelCommand, operationCancelCommandWith, operationCancelStepsOver, type OperationCancelSteps } from "../../src/commands/operation/cancel.js";
import { operationInspectCommand, operationInspectCommandWith, operationInspectStepsOver } from "../../src/commands/operation/inspect.js";
import { operationListCommand, operationListCommandWith, operationListStepsOver, type OperationListSteps } from "../../src/commands/operation/list.js";
import * as resolve from "../../src/commands/operation/resolve.js";

const AT = "2026-10-14T00:00:00.000Z";
const MANIFEST = { runId: "opr_1", bundleId: "bnd_1", workspaceId: "w" } as never;
const RESOLVED = resolve.resolvedFromManifest(MANIFEST);
const RUN = { runId: "opr_1", bundleId: "bnd_1", workspaceId: "w", state: "applying", counters: {} } as never;

let stdout: string[];
let stderr: string[];
beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(console, "error").mockImplementation((line) => { stderr.push(String(line)); });
});
afterEach(() => { vi.restoreAllMocks(); });

/** The one JSON envelope written to stdout. */
const envelope = () => JSON.parse(stdout.join(""));

/** Memory resolution: an error string, or the resolved fixture run in `state`. */
const resolving = (log: string[], answer: string | { state: string }) => async (target: string) => {
  log.push(`resolve ${target}`);
  return (typeof answer === "string" ? { error: answer } : { resolved: RESOLVED, run: { ...(RUN as object), ...answer } }) as never;
};

/** Memory cancel steps; each call logged. */
function cancelSteps(log: string[], answer: string | { state: string }): OperationCancelSteps {
  return {
    resolve: resolving(log, answer),
    writeCancel: async (input) => { log.push(`write ${input.workspaceId} ${input.runId} ${input.requester} ${input.at}`); return "created"; },
    now: () => { log.push("now"); return AT; },
  };
}

describe("operation cancel over its steps", () => {
  it("C1 refuses an unresolved target and a run past cancelling, each before any write", async () => {
    const log: string[] = [];
    expect(await operationCancelCommandWith(cancelSteps(log, "No operation bundle or run matches \"x\"."), "x")).toBe(1);
    expect(await operationCancelCommandWith(cancelSteps(log, { state: "succeeded" }), "opr_1")).toBe(1);
    expect([log, stderr.map((line) => line.replace(/^\S+Error:\S+ /u, ""))]).toEqual([["resolve x", "resolve opr_1"], [
      "No operation bundle or run matches \"x\".", "Run opr_1 is succeeded; a cancel advisory cannot take effect.",
    ]]);
  });

  it("C2 writes the advisory for a cancellable run under the CLI operator at the clock's instant", async () => {
    const log: string[] = [];
    expect(await operationCancelCommandWith(cancelSteps(log, { state: "recovery-required" }), "bnd_1", { json: true })).toBe(0);
    expect([log, envelope()]).toEqual([["resolve bnd_1", "now", `write w opr_1 ${CLI_OPERATOR_ID} ${AT}`], { workspaceId: "w", bundleId: "bnd_1", runId: "opr_1", cancel: "created" }]);
  });
});

describe("operation inspect over its steps", () => {
  it("I1 refuses an unresolved target without reading the advisory; reads it under the RESOLVED identity", async () => {
    const log: string[] = [];
    const steps = (answer: string | { state: string }) => ({
      resolve: resolving(log, answer),
      readCancel: async (workspaceId: string, runId: string) => { log.push(`cancel ${workspaceId} ${runId}`); return { status: "present", request: { requester: "op", at: AT } } as never; },
    });
    expect(await operationInspectCommandWith(steps("No readable operation key for opr_1."), "bnd_1")).toBe(1);
    expect(await operationInspectCommandWith(steps({ state: "applying" }), "bnd_1", { json: true })).toBe(0);
    expect([log, envelope().state, envelope().cancel]).toEqual([["resolve bnd_1", "resolve bnd_1", "cancel w opr_1"], "applying", { status: "present", requester: "op", at: AT }]);
  });
});

/** Memory list steps over two manifests; `key` null is no readable key. Each call logged. */
function listSteps(log: string[], key: string | null): OperationListSteps {
  const second = { runId: "opr_2", bundleId: "bnd_2", workspaceId: "w" };
  return {
    inventory: async () => { log.push("inventory"); return { manifests: [MANIFEST, second], problems: [{}] } as never; },
    recoveryState: async () => { log.push("recovery"); return "bundle-recovery-required"; },
    keyEpoch: async () => { log.push("key"); return key as never; },
    run: async (resolved) => { log.push(`run ${resolved.runId}`); return (resolved.runId === "opr_1" ? { status: "ok", run: RUN } : { status: "absent" }) as never; },
  };
}

describe("operation list over its steps", () => {
  it("L1 reads inventory, recovery, then the key; no key marks every row without reading a run", async () => {
    const log: string[] = [];
    expect(await operationListCommandWith(listSteps(log, null), { json: true })).toBe(0);
    const { recoveryState, inventoryProblems, bundles } = envelope();
    expect([log, recoveryState, inventoryProblems, bundles.map((row: { detail: string }) => row.detail)]).toEqual([
      ["inventory", "recovery", "key"], "bundle-recovery-required", 1, ["integrity-key-unavailable", "integrity-key-unavailable"],
    ]);
  });

  it("L2 reads each manifest's run under the key: ok carries its state, absent is run-absent", async () => {
    const log: string[] = [];
    await operationListCommandWith(listSteps(log, "sha256:k"), { json: true });
    expect([log, envelope().bundles.map((row: { state: string | null; detail: string | null }) => [row.state, row.detail])]).toEqual([
      ["inventory", "recovery", "key", "run opr_1", "run opr_2"], [["applying", null], [null, "run-absent"]],
    ]);
  });
});

describe("the compositions and the root forms", () => {
  it("B1 the compositions reach target resolution's and recovery's own bodies", async () => {
    const reads = { inventory: async () => ({ manifests: [], problems: [] }), keyEpoch: async () => null, run: async () => ({ status: "absent" }) } as never;
    expect(await operationCancelCommandWith(operationCancelStepsOver(reads, async () => "created", () => AT), "nope")).toBe(1);
    expect(await operationInspectCommandWith(operationInspectStepsOver(reads, async () => ({ status: "absent" })), "nope")).toBe(1);
    expect(stderr.every((line) => line.includes("No operation bundle or run matches \"nope\"."))).toBe(true);
    const recovery = vi.spyOn(lockGate, "resolveOperationRecoveryStateFrom").mockResolvedValue("clean");
    const over = vi.spyOn(resolve, "targetRunReadsOver").mockReturnValue(reads);
    const leaves = { tag: "leaves" } as never;
    await operationListCommandWith(operationListStepsOver(leaves, { tag: "recovery" } as never), { json: true });
    expect([over.mock.calls, recovery.mock.calls, envelope().recoveryState]).toEqual([[[leaves]], [[{ tag: "recovery" }]], "clean"]);
  });

  it("B2 each root form reaches the incumbents with its root", async () => {
    vi.spyOn(resolve, "resolveTargetRun").mockResolvedValue({ resolved: RESOLVED, run: RUN });
    const write = vi.spyOn(cancelRequest, "writeCancelRequestLockFree").mockResolvedValue("exists");
    const read = vi.spyOn(cancelRequest, "readCancelRequest").mockResolvedValue({ status: "absent" });
    const inventory = vi.spyOn(bundleTarget, "loadOperationInventory").mockResolvedValue({ manifests: [MANIFEST], problems: [] } as never);
    const key = vi.spyOn(resolve, "readKeyEpoch").mockResolvedValue(null);
    const recovery = vi.spyOn(lockGate, "resolveOperationRecoveryState").mockResolvedValue("clean");
    const json = { json: true };
    expect([await operationCancelCommand("/project", "opr_1", json), await operationInspectCommand("/project", "opr_1", json), await operationListCommand("/project", json)]).toEqual([0, 0, 0]);
    expect([write.mock.calls[0]?.[0], read.mock.calls, inventory.mock.calls, recovery.mock.calls, key.mock.calls]).toEqual([
      "/project", [["/project", "w", "opr_1"]], [["/project"]], [["/project"]], [["/project"]],
    ]);
  });
});
