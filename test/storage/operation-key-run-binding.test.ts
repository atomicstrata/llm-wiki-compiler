/**
 * @file test/storage/operation-key-run-binding.test.ts
 * @description The operation key and run reads over their own LEAF seams: the one
 * key body `readOperationKeyFrom(OperationKeyLeafReads)` and the one run body
 * `readOperationRunFrom(OperationRunLeafReads)`. The root readers keep their
 * signatures and reach those bodies over the local-disk leaves
 * (`diskCurrentOperationKeyLeafReads`, `diskOperationRunLeafReads`).
 *
 * HOW IT IS BUILT. Real projects are staged on disk with the existing operation
 * fixtures (`executor-fixtures.ts`), which mint a real key and a real signed run.
 * Disk cases change only the key leaf (mode, a second hard link, an oversize body)
 * to show the local-disk half still refuses. Memory cases hand the bodies a scripted
 * leaf double holding the REAL key text and run text read back from that project.
 *
 * WHAT IS MEMORY ONLY. A scripted leaf is trusted exactly as far as the test supplies
 * it: it proves the bodies' decode, order, codes, caps and authentication, not
 * confinement, owner, mode, links or the handle-bound read, which stay on the disk
 * side and are covered by the disk cases here and by the existing operation suites.
 */

import { chmod, link, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as confinedRead from "../../src/utils/confined-read.js";
import type { CappedLeafRead } from "../../src/utils/confined-read.js";
import { MAX_RUN_BYTES } from "../../src/operation-bundles/constants.js";
import * as durableLeaf from "../../src/operation-bundles/durable-leaf.js";
import * as keyEpoch from "../../src/operation-bundles/key-epoch.js";
import {
  diskCurrentOperationKeyLeafReads, readOperationKey, readOperationKeyFrom, type OperationKeyLeafReads, type OperationKeyRead,
} from "../../src/operation-bundles/key-epoch.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { operationRunBinding } from "../../src/operation-bundles/run-integrity.js";
import {
  diskOperationRunLeafReads, readOperationRun, readOperationRunFrom, type OperationRunLeafReads, type OperationRunRead,
} from "../../src/operation-bundles/run-store.js";
import type { OperationRunBinding } from "../../src/operation-bundles/run-types.js";
import { tempRootTracker } from "../temp-roots.js";
import { readStagedRun, stageSourceBundle, WORKSPACE } from "../operation-bundles/executor-fixtures.js";

const PREFIX = "operation-key-run-binding-";
/** The project-global operation key leaf (`key-epoch.ts`). */
const KEY_LEAF = path.join(".llmwiki", "operation-bundles.runkey");
const KEY_CAP = 1_024;
/** 32 zero bytes, canonically; and the same bytes with non-zero padding bits (not canonical). */
const ZERO_KEY = `${"A".repeat(43)}=`;
const NONCANONICAL_KEY = `${"A".repeat(42)}B=`;

const tracker = tempRootTracker();
let root = "";
let binding: OperationRunBinding;
let keyText = "";
let runText = "";
beforeAll(async () => {
  root = await tracker.create(PREFIX);
  const run = await readStagedRun(root, await stageSourceBundle(root));
  binding = operationRunBinding(run);
  keyText = await readFile(path.join(root, KEY_LEAF), "utf8");
  runText = await readFile(operationPaths(root, WORKSPACE).runFile(binding.runId), "utf8");
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => tracker.cleanup());

/** A scripted key leaf: one answer, the cap each read asked for. */
function keyLeaf(answer: CappedLeafRead, caps: number[] = []): OperationKeyLeafReads {
  return { readKeyLeaf: async (maxBytes) => { caps.push(maxBytes); return answer; } };
}

/** A scripted run store: the leaf answer (or a throw) and a key answer, every read logged in order. */
function runLeaves(leaf: CappedLeafRead | Error, key: OperationKeyRead, log: string[]): OperationRunLeafReads {
  return {
    readRunLeaf: async (asked, maxBytes) => { log.push(`leaf ${asked.workspaceId} ${maxBytes}`); if (leaf instanceof Error) throw leaf; return leaf; },
    readKey: async () => { log.push("key"); return key; },
  };
}

/** A fresh staged copy of the project's key state, for a disk case that damages the key leaf. */
async function stagedRoot(): Promise<string> {
  const fresh = await tracker.create(PREFIX);
  await stageSourceBundle(fresh);
  return fresh;
}

describe("the operation key read: one body, the local-disk leaf behind the root reader", () => {
  it("K1 reads a real key through the root reader and the body over the disk leaf alike; a project with no key is absent", async () => {
    const viaRoot = await readOperationKey(root);
    expect(viaRoot.status).toBe("ok");
    expect(await readOperationKeyFrom(diskCurrentOperationKeyLeafReads(root))).toEqual(viaRoot);
    const bare = await tracker.create(PREFIX);
    expect([await readOperationKey(bare), await readOperationKeyFrom(diskCurrentOperationKeyLeafReads(bare))]).toEqual([{ status: "absent" }, { status: "absent" }]);
  });

  it("K2 decodes in the body: the real key text is ok with the same epoch; absent, unavailable, non-canonical and wrong-length leaves are not; the cap asked is the key cap", async () => {
    const caps: number[] = [];
    const real = await readOperationKey(root);
    expect(await readOperationKeyFrom(keyLeaf({ kind: "ok", body: keyText }, caps))).toEqual(real);
    const refused = [{ kind: "absent" as const }, { kind: "unavailable" as const }, { kind: "ok" as const, body: NONCANONICAL_KEY }, { kind: "ok" as const, body: "AAAA" }];
    expect(await Promise.all(refused.map((answer) => readOperationKeyFrom(keyLeaf(answer, caps)))))
      .toEqual([{ status: "absent" }, { status: "unavailable" }, { status: "unavailable" }, { status: "unavailable" }]);
    expect([(await readOperationKeyFrom(keyLeaf({ kind: "ok", body: ZERO_KEY }))).status, caps]).toEqual(["ok", [KEY_CAP, KEY_CAP, KEY_CAP, KEY_CAP, KEY_CAP]]);
  });

  it("K3 keeps the local-disk refusals: a group-readable key, a second hard link, and an oversize key leaf are each unavailable", async () => {
    const loose = await stagedRoot();
    await chmod(path.join(loose, KEY_LEAF), 0o644);
    const linked = await stagedRoot();
    await link(path.join(linked, KEY_LEAF), path.join(linked, ".llmwiki", "stray-key-link"));
    const oversize = await stagedRoot();
    await writeFile(path.join(oversize, KEY_LEAF), "A".repeat(KEY_CAP + 1), { mode: 0o600 });
    expect(await Promise.all([loose, linked, oversize].map((at) => readOperationKey(at)))).toEqual([{ status: "unavailable" }, { status: "unavailable" }, { status: "unavailable" }]);
  });
});

describe("the operation run read: one body, leaf first, then a fresh key, then authentication", () => {
  it("R1 reads the real signed run through the root reader and the body over the disk leaves alike", async () => {
    const viaRoot = await readOperationRun(root, binding);
    expect([viaRoot.status, viaRoot.status === "ok" && viaRoot.run.state]).toEqual(["ok", "awaiting-approval"]);
    expect(await readOperationRunFrom(diskOperationRunLeafReads(root), binding)).toEqual(viaRoot);
  });

  it("R2 keeps the operation codes and order: identity and run-leaf carry NO code and read no key; the key is read only for a present leaf", async () => {
    const key = await readOperationKey(root);
    const read = async (leaf: CappedLeafRead | Error, k: OperationKeyRead = key) => { const log: string[] = []; return [await readOperationRunFrom(runLeaves(leaf, k, log), binding), log]; };
    const leafRead = `leaf ${WORKSPACE} ${MAX_RUN_BYTES}`;
    expect(await read(new Error("unsafe identity"))).toEqual([{ status: "unavailable", detail: "identity" }, [leafRead]]);
    expect(await read({ kind: "absent" })).toEqual([{ status: "absent" }, [leafRead]]);
    expect(await read({ kind: "unavailable" })).toEqual([{ status: "unavailable", detail: "run-leaf" }, [leafRead]]);
    expect(await read({ kind: "ok", body: runText }, { status: "absent" })).toEqual([{ status: "unavailable", detail: "key-missing", code: "integrity-key-missing" }, [leafRead, "key"]]);
    expect(await read({ kind: "ok", body: runText }, { status: "unavailable" })).toEqual([{ status: "unavailable", detail: "key-unreadable", code: "integrity-key-unreadable" }, [leafRead, "key"]]);
  });

  it("R3 authenticates in the body: the real run text is ok; a tampered byte, another key, or another binding is run-integrity-invalid", async () => {
    const key = await readOperationKey(root);
    const zero = await readOperationKeyFrom(keyLeaf({ kind: "ok", body: ZERO_KEY }));
    const invalid: OperationRunRead = { status: "unavailable", detail: "run-invalid", code: "run-integrity-invalid" };
    const read = (body: string, k: OperationKeyRead, at: OperationRunBinding = binding) => readOperationRunFrom(runLeaves({ kind: "ok", body }, k, []), at);
    expect(await read(runText, key)).toEqual(await readOperationRun(root, binding));
    expect([await read(runText.replace("awaiting-approval", "awaiting-approvaX"), key), await read(runText, zero), await read(runText, key, { ...binding, workspaceId: "elsewhere" })])
      .toEqual([invalid, invalid, invalid]);
  });

  it("R4 reads the key FRESH on every run read (no caching), and the bound bodies make no ambient read while the root reader reaches each incumbent", async () => {
    const key = await readOperationKey(root);
    const log: string[] = [];
    const leaves = runLeaves({ kind: "ok", body: runText }, key, log);
    const spies = [vi.spyOn(durableLeaf, "readDurableOperationLeaf"), vi.spyOn(confinedRead, "openConfinedLeaf"), vi.spyOn(keyEpoch, "readOperationKey")];
    await readOperationRunFrom(leaves, binding);
    await readOperationRunFrom(leaves, binding);
    expect([log.filter((entry) => entry === "key").length, spies.map((spy) => spy.mock.calls.length)]).toEqual([2, [0, 0, 0]]);
    expect((await readOperationRun(root, binding)).status).toBe("ok");
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true]);
  });
});
