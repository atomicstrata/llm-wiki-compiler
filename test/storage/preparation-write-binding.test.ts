/**
 * @file test/storage/preparation-write-binding.test.ts
 * @description The preparation WRITERS as root-free bodies over memory steps: the
 * run writers (`…With(PreparationRunWriteSteps)`), the advisory cancellation
 * (`writePreparationCancelWith`, `readPreparationCancelFrom`), the evidence
 * create-only writers (`…EvidenceCreateOnlyWith`) and the custody publish leg
 * (`publishCustodyWith`).
 *
 * HOW IT IS BUILT. A real preparation is staged once with the existing fixtures,
 * and the memory steps answer with ITS key and run. Custody uses REAL host temp
 * files (the host boundary is not doubled) and memory PROJECT steps. The doubles
 * prove each body's order and fail-closed refusals, not confinement, durability or
 * create-only publication, which stay in the local-disk steps and are covered by
 * the existing run-store, cancellation, evidence and attempt suites. The last case
 * shows the bodies make no ambient physical call while the shipped root entries
 * reach the incumbents with exact arguments.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as advisoryFile from "../../src/utils/advisory-file.js";
import * as atomicWriteModule from "../../src/utils/atomic-write.js";
import * as runStoreIo from "../../src/utils/run-store-io.js";
import { copyIntoCustody, createCustodyDir, discardCustody, publishCustodyWith } from "../../src/preparations/attempts/custody.js";
import {
  readPreparationCancelFrom, writePreparationCancelLockFree, writePreparationCancelWith, type PreparationCancelLeaves,
} from "../../src/preparations/cancellation.js";
import {
  streamPreparationEvidenceCreateOnlyWith, writePreparationEvidenceCreateOnlyWith, type EvidenceSink, type PreparationEvidenceWriteSteps,
} from "../../src/preparations/evidence-store.js";
import { readPreparationKey, type PreparationKeyRead } from "../../src/preparations/key-epoch.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { preparationRunPredecessor, verifyPreparationRunIntegrity } from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import {
  appendAbandonedTransitionWith, appendPreparationTransitionWith, readPreparationRun, type PreparationRunWriteSteps,
} from "../../src/preparations/run-store.js";
import type { PreparationRunBinding, PreparationRunV1 } from "../../src/preparations/run-types.js";
import { stagePreparationIn } from "../preparations/attempt-fixture.js";

const ACTOR = { id: "operator", surface: "cli" as const };
const AT = "2026-07-20T00:01:00.000Z";
const PARK = { type: "recovery-required" as const, stateAfter: "recovery-required" as const, actor: ACTOR, at: AT, payload: { kind: "problem" as const, code: "preparation-effect-outcome-unknown" as const } };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
let root = "", binding: PreparationRunBinding, run: PreparationRunV1, key: Extract<PreparationKeyRead, { status: "ok" }>;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "prep-write-binding-")); roots.push(root);
  binding = (await stagePreparationIn(root)).binding;
  const read = await readPreparationRun(root, binding), keyRead = await readPreparationKey(root);
  if (read.status !== "ok" || keyRead.status !== "ok") throw new Error("fixture unreadable");
  run = read.run; key = keyRead;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await Promise.all(roots.map((at) => rm(at, { recursive: true, force: true }))); });

/** Memory run steps over the real key and run; every call logged, every replacement kept. */
function runSteps(log: string[], written: string[], over: Partial<PreparationRunWriteSteps> = {}): PreparationRunWriteSteps {
  return {
    readRun: async () => { log.push("readRun"); return { status: "ok", run }; },
    readKey: async () => { log.push("readKey"); return key; },
    readEvidence: async () => { log.push("readEvidence"); return { status: "ok", byteCount: 1 }; },
    publishGenesis: async (_b, serialized) => { log.push("publishGenesis"); written.push(serialized); },
    replaceRun: async (_b, serialized) => { log.push("replaceRun"); written.push(serialized); },
    ...over,
  };
}

describe("the preparation run writers over memory steps", () => {
  it("P1 appends after the predecessor read and a FRESH key, one authenticated next state; a stale predecessor stops before the key", async () => {
    const log: string[] = [], written: string[] = [];
    await appendPreparationTransitionWith(runSteps(log, written), binding, preparationRunPredecessor(run), PARK);
    const parsed = parsePreparationRun(written[0]!, binding);
    expect([log, parsed.stateVersion, parsed.state, verifyPreparationRunIntegrity(parsed, key.key, binding)]).toEqual([["readRun", "readKey", "replaceRun"], run.stateVersion + 1, "recovery-required", true]);
    const stale: string[] = [];
    await expect(appendPreparationTransitionWith(runSteps(stale, []), binding, { ...preparationRunPredecessor(run), stateVersion: 99 }, PARK)).rejects.toThrow("predecessor changed");
    await expect(appendPreparationTransitionWith(runSteps([], []), binding, preparationRunPredecessor(run), { ...PARK, type: "abandoned" } as never)).rejects.toThrow("evidence-verifying control writer");
    expect(stale).toEqual(["readRun"]);
  });

  it("P2 verifies every abandonment evidence byte count BEFORE reading the run or writing", async () => {
    const log: string[] = [];
    const findings = [{ code: "residual-effect", evidence: { digest: `sha256:${"a".repeat(64)}`, byteCount: 2 } }];
    await expect(appendAbandonedTransitionWith(runSteps(log, []), binding, preparationRunPredecessor(run), { actor: ACTOR, at: AT, confirmResidualState: true, findings } as never))
      .rejects.toThrow("evidence is unavailable or mismatched");
    expect(log).toEqual(["readEvidence"]);
  });
});

describe("the advisory, evidence and custody bodies over memory steps", () => {
  it("P3 validates and canonicalizes the advisory before creating it, and binds a read to the path's own run id", async () => {
    const created: Buffer[] = [];
    const leaves: PreparationCancelLeaves = {
      createAdvisory: async (_ws, _run, bytes) => { created.push(bytes); return "created"; },
      readAdvisory: async (_ws, _run, _max, parse) => { try { return { status: "present", request: parse(created[0]!) }; } catch { return { status: "unavailable", detail: "x" }; } },
      removeAdvisory: async () => {},
    };
    const input = { workspaceId: binding.workspaceId, runId: binding.runId, requester: "op", at: AT, nonce: "0".repeat(32) };
    await expect(writePreparationCancelWith(leaves, { ...input, nonce: "bad" })).rejects.toThrow("nonce");
    expect([created.length, await writePreparationCancelWith(leaves, input)]).toEqual([0, "created"]);
    expect((await readPreparationCancelFrom(leaves, binding.workspaceId, binding.runId)).status).toBe("present");
    const otherRun = `prr_${"f".repeat(32)}` as typeof binding.runId;
    expect((await readPreparationCancelFrom(leaves, binding.workspaceId, otherRun)).status).toBe("unavailable");
  });

  it("P4 links streamed evidence only after the producer verifies it, re-reads only on a reported collision, and maps faults closed", async () => {
    const bytes = Buffer.from("evidence bytes\n"), log: string[] = [];
    const steps = (outcome: "created" | "collision"): PreparationEvidenceWriteSteps => ({
      createLeaf: async () => { log.push(`create:${outcome}`); return outcome; },
      streamCreateLeaf: async (_l, _d, produce) => {
        const sink: EvidenceSink = { write: async () => {} };
        const byteCount = await produce(sink); log.push(`link:${outcome}`);
        return outcome === "created" ? { status: "created", byteCount } : { status: "collision" };
      },
      readEvidence: async () => { log.push("reread"); return { status: "ok", byteCount: bytes.length }; },
    });
    const source = { read: async (buffer: Buffer, _o: number, _l: number, position: number) => ({ bytesRead: position === 0 ? bytes.copy(buffer) : 0 }) };
    const location = { workspaceId: binding.workspaceId, preparationId: binding.preparationId };
    expect(await streamPreparationEvidenceCreateOnlyWith(steps("created"), location, source, sha(bytes))).toEqual({ status: "written", result: "created", byteCount: bytes.length });
    expect(await streamPreparationEvidenceCreateOnlyWith(steps("collision"), location, source, sha(bytes))).toEqual({ status: "written", result: "same", byteCount: bytes.length });
    expect(await streamPreparationEvidenceCreateOnlyWith(steps("created"), location, source, "0".repeat(64))).toMatchObject({ status: "digest-mismatch" });
    expect(await streamPreparationEvidenceCreateOnlyWith(steps("created"), location, source, sha(bytes), 3)).toEqual({ status: "oversize" });
    expect([await writePreparationEvidenceCreateOnlyWith(steps("created"), location, bytes), await writePreparationEvidenceCreateOnlyWith(steps("collision"), location, bytes)]).toEqual(["created", "same"]);
    expect(log).toEqual(["link:created", "link:collision", "reread", "create:created", "create:collision", "reread"]);
  });

  it("P5 verifies EVERY host custody object before linking any into the project, and links through the streaming body", async () => {
    const host = await mkdtemp(path.join(os.tmpdir(), "prep-custody-source-")); roots.push(host);
    const good = Buffer.from("good output\n"), source = path.join(host, "out");
    await writeFile(source, good);
    const dir = await createCustodyDir();
    expect(await copyIntoCustody(source, dir, sha(good), 1024)).toBe(good.length);
    const linked: string[] = [];
    const steps: PreparationEvidenceWriteSteps = {
      createLeaf: async () => "created", readEvidence: async () => ({ status: "absent" }),
      streamCreateLeaf: async (_l, digest, produce) => { const byteCount = await produce({ write: async () => {} }); linked.push(digest); return { status: "created", byteCount }; },
    };
    const location = { workspaceId: binding.workspaceId, preparationId: binding.preparationId };
    const item = (digest: string) => ({ tempPath: path.join(dir, sha(good)), ref: { digest: `sha256:${digest}`, byteCount: good.length } }) as never;
    expect(await publishCustodyWith(steps, location, [item(sha(good)), item("0".repeat(64))], 1024)).toBe(false);
    expect(linked).toEqual([]);
    expect(await publishCustodyWith(steps, location, [item(sha(good))], 1024)).toBe(true);
    expect(linked).toEqual([sha(good)]);
    await discardCustody(dir);
  });

  it("P6 makes no ambient physical call from the bound bodies, while the shipped root entries reach the incumbents with exact arguments", async () => {
    const spies = [vi.spyOn(atomicWriteModule, "atomicWrite"), vi.spyOn(atomicWriteModule, "atomicWriteNoReplaceDurable"), vi.spyOn(atomicWriteModule, "atomicStreamCreateOnlyDurable"),
      vi.spyOn(runStoreIo, "publishRunGenesis"), vi.spyOn(advisoryFile, "writeAdvisoryCreateOnly")];
    await appendPreparationTransitionWith(runSteps([], []), binding, preparationRunPredecessor(run), PARK);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    const input = { workspaceId: binding.workspaceId, runId: binding.runId, requester: "op", at: AT, nonce: "1".repeat(32) };
    expect(await writePreparationCancelLockFree(root, input)).toBe("created");
    expect(spies[4]!.mock.calls.map((call) => call.slice(0, 2))).toEqual([[root, preparationPaths(root, binding.workspaceId).cancelFile(binding.runId)]]);
  });
});
