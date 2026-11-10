/**
 * @file test/storage/key-epoch-create-binding.test.ts
 * @description The operation and preparation empty-epoch key creation as ONE
 * create-or-refuse body each, `createOperationKeyForEmptyEpochLockedWith` and
 * `prepareKeyForEmptyEpochLockedWith`, over their create steps, with no project.
 * This file uses the bodies, which exist only after creation was given its steps,
 * so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Both epochs run the same cases from one table. Memory steps
 * answer the current-key read, the crash-ready read and the no-replace
 * publication, and log each call, so the policy is pinned: an empty inventory
 * before any step, unavailable refuses, an existing key reconciles then refuses,
 * a crash-ready key is reused byte for byte, an absent one is minted fresh, and a
 * collision re-reads the current key. The preparation epoch's two steps are shown
 * apart. The compositions are shown reading through the key readers' own bodies,
 * and each root form publishing a real key under its root.
 *
 * NOT SHOWN HERE: the confined key-leaf reads and the durable write themselves;
 * the key read and atomic-write suites show those.
 */

import { mkdir, stat } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as operationKey from "../../src/operation-bundles/key-epoch.js";
import { operationKeyEpochId } from "../../src/operation-bundles/run-integrity.js";
import * as preparationKey from "../../src/preparations/key-epoch.js";
import { preparationKeyEpochId } from "../../src/preparations/run-integrity.js";
import * as atomicWriteModule from "../../src/utils/atomic-write.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterAll(() => tracker.cleanup());
afterEach(() => { vi.restoreAllMocks(); });

/** An exact empty inventory over `classes`. */
const emptyOf = (classes: string[]) => Object.fromEntries(classes.map((name) => [name, { count: 0, bytes: 0, health: "ok" }])) as never;

/** One epoch's creation, normalized to the epoch id it published. */
interface Epoch {
  name: string; inventory: never; epochOf: (key: Buffer) => string;
  create: (steps: never, inventory: never, beforePublish?: () => Promise<void>) => Promise<string>;
  over: typeof operationKey.operationKeyCreateStepsOver; createAt: (root: string) => Promise<string>;
}

const EPOCHS: Epoch[] = [
  {
    name: "operation", inventory: emptyOf(["bundles", "runs", "payloads", "evidence", "cancelRequests", "orphans"]), epochOf: operationKeyEpochId,
    create: async (steps, inventory, beforePublishForTest) => (await operationKey.createOperationKeyForEmptyEpochLockedWith(steps, inventory, { beforePublishForTest })).keyEpochId,
    over: operationKey.operationKeyCreateStepsOver, createAt: async (root) => (await operationKey.createOperationKeyForEmptyEpochLocked(root, EPOCHS[0]!.inventory)).keyEpochId,
  },
  {
    name: "preparation", inventory: emptyOf(["manifests", "runs", "evidence", "cancelRequests", "orphans"]), epochOf: preparationKeyEpochId,
    create: async (steps, inventory, beforePublishForTest) => {
      const prepared = await preparationKey.prepareKeyForEmptyEpochLockedWith(steps, inventory, { beforePublishForTest });
      await prepared.publish();
      return prepared.keyEpochId;
    },
    over: preparationKey.preparationKeyCreateStepsOver as never,
    createAt: async (root) => { const prepared = await preparationKey.prepareKeyForEmptyEpochLocked(root, EPOCHS[1]!.inventory); await prepared.publish(); return prepared.keyEpochId; },
  },
];

const KEY = Buffer.alloc(32, 7);
const okKey = (key: Buffer) => ({ status: "ok", key, keyEpochId: "unused" });

/** Memory create steps: `current` answers each current read in turn, `crash` the crash-ready read, `publish` the publication. */
function stepsOf(log: string[], current: object[], crash: object = { status: "absent" }, publish: "created" | "collision" | Error = "created") {
  return {
    readCurrentKey: async () => { log.push("current"); return current.shift(); },
    readCrashReadyKey: async () => { log.push("crash"); return crash; },
    publishKey: async (key: Buffer) => { log.push(`publish ${key.length}`); if (publish instanceof Error) throw publish; return publish; },
  } as never;
}

describe.each(EPOCHS)("$name empty-epoch key creation over its steps", (epoch) => {
  it("C1 refuses a non-empty inventory before any step; an absent key mints fresh and publishes it", async () => {
    const log: string[] = [];
    const populated = { ...(epoch.inventory as object), runs: { count: 1, bytes: 9, health: "ok" } } as never;
    await expect(epoch.create(stepsOf(log, []), populated)).rejects.toThrow(`${epoch.name} key creation requires an empty epoch inventory`);
    expect(log).toEqual([]);
    const id = await epoch.create(stepsOf(log, [{ status: "absent" }]), epoch.inventory, async () => { log.push("before-publish"); });
    expect([log, id.startsWith("sha256:"), id === epoch.epochOf(KEY)]).toEqual([["current", "crash", "before-publish", "publish 32"], true, false]);
  });

  it("C2 reuses a crash-ready key byte for byte; an unavailable crash key refuses before publishing", async () => {
    expect(await epoch.create(stepsOf([], [{ status: "absent" }], okKey(KEY)), epoch.inventory)).toBe(epoch.epochOf(KEY));
    const log: string[] = [];
    await expect(epoch.create(stepsOf(log, [{ status: "absent" }], { status: "unavailable" }), epoch.inventory)).rejects.toThrow(`${epoch.name} key recovery is unavailable`);
    expect(log).toEqual(["current", "crash"]);
  });

  it("C3 an unavailable key refuses; an existing key reconciles through the publication and refuses, or propagates its fault", async () => {
    const log: string[] = [];
    await expect(epoch.create(stepsOf(log, [{ status: "unavailable" }]), epoch.inventory)).rejects.toThrow(`${epoch.name} key is unavailable`);
    await expect(epoch.create(stepsOf(log, [okKey(KEY)], undefined, "collision"), epoch.inventory)).rejects.toThrow(`${epoch.name} key epoch already exists`);
    await expect(epoch.create(stepsOf(log, [okKey(KEY)], undefined, "created"), epoch.inventory)).rejects.toThrow(`${epoch.name} key epoch already exists`);
    await expect(epoch.create(stepsOf(log, [okKey(KEY)], undefined, new Error("EIO")), epoch.inventory)).rejects.toThrow("EIO");
    expect(log).toEqual(["current", "current", "publish 32", "current", "publish 32", "current", "publish 32"]);
  });

  it("C4 a collision re-reads the current key and names its status", async () => {
    const log: string[] = [];
    await expect(epoch.create(stepsOf(log, [{ status: "absent" }, okKey(KEY)], undefined, "collision"), epoch.inventory)).rejects.toThrow(`${epoch.name} key creation collision: ok`);
    expect(log).toEqual(["current", "crash", "publish 32", "current"]);
  });

  it("B1 the composition reads through the key reader's own body for both leaves", async () => {
    const log: string[] = [];
    const leaf = (name: string, body?: string) => ({ readKeyLeaf: async (maxBytes: number) => { log.push(`${name} ${maxBytes}`); return body === undefined ? { kind: "absent" } : { kind: "ok", body }; } });
    const steps = epoch.over({ current: leaf("current"), crashReady: leaf("crash", KEY.toString("base64")) } as never, async () => "created");
    expect(await epoch.create(steps as never, epoch.inventory)).toBe(epoch.epochOf(KEY));
    expect(log.map((line) => line.split(" ")[0])).toEqual(["current", "crash"]);
  });

  it("B2 the root form publishes a real 0600 key under its root through the incumbent no-replace write", async () => {
    const root = await tracker.create(`key-epoch-create-${epoch.name}-`, { real: true });
    await mkdir(`${root}/.llmwiki`, { recursive: true });
    const write = vi.spyOn(atomicWriteModule, "atomicWriteNoReplaceDurable");
    const id = await epoch.createAt(root);
    const [file, text, options] = write.mock.calls[0]!;
    expect([String(file).startsWith(`${root}/.llmwiki/`), epoch.epochOf(Buffer.from(String(text), "base64")) === id, options]).toEqual([true, true, { confineRoot: root, exactParent: true, mode: 0o600 }]);
    expect((await stat(String(file))).mode & 0o777).toBe(0o600);
  });
});

describe("the preparation epoch's two steps", () => {
  it("P1 mints and reports the epoch without publishing until asked", async () => {
    const log: string[] = [];
    const prepared = await preparationKey.prepareKeyForEmptyEpochLockedWith(stepsOf(log, [{ status: "absent" }], okKey(KEY)), EPOCHS[1]!.inventory);
    expect([prepared.keyEpochId, log]).toEqual([preparationKeyEpochId(KEY), ["current", "crash"]]);
    await prepared.publish();
    expect(log).toEqual(["current", "crash", "publish 32"]);
  });
});
