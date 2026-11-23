/**
 * @file test/atomic-write-directory-sync-scope-recovery.test.ts
 * @description Collision, crash-state recovery and post-publication faults of
 * strict create-only publication UNDER a batch {@link DirectorySyncScope}.
 * The broad atomic-write suites run unscoped; these cases replay the same
 * protocol states with a live, already anchored scope, so a skipped ancestor
 * sync can never change what a collision, a recovered deterministic temp, a
 * committed-alias replay or a retry after an injected fault leaves on disk.
 * Each scenario first anchors the scope with a sibling write in the same
 * directory, then exercises the state with the same scope.
 */

import { link, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { beforeEach } from "./config/storage-profile-hooks.js";
import {
  AtomicWriteCollisionError, atomicWriteNoReplaceDurable, type AtomicWriteNoReplaceDurableScopedOptions,
} from "../src/utils/atomic-write.js";
import { DirectorySyncScope } from "../src/utils/directory-sync-scope.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
let scope: DirectorySyncScope;
/** Canonical test root (the scope and confinement must name the same real root). */
let real = "";
let parent = "";
let target = "";

beforeEach(async () => {
  real = await realpath(root.dir);
  scope = new DirectorySyncScope(real);
  parent = path.join(real, "batch");
  target = path.join(parent, "record");
  await mkdir(parent);
  await publish(path.join(parent, "anchor"), "anchor");
});

/** Scoped create-only publish under the test root, with optional extra seams. */
function publish(file: string, body: string, extra: AtomicWriteNoReplaceDurableScopedOptions = {}): Promise<void> {
  return atomicWriteNoReplaceDurable(file, body, { confineRoot: real, directorySyncScope: scope, ...extra });
}

/** Directory entries of the batch directory other than the anchoring sibling. */
async function entries(): Promise<string[]> {
  return (await readdir(parent)).filter((name) => name !== "anchor").sort();
}

describe("scoped crash-state recovery", () => {
  it.each([
    ["ready-only", ".tmp", "body"],
    ["scratch-only partial", ".writing", "bo"],
    ["scratch-only complete", ".writing", "body"],
  ])("recovers a %s crash state and publishes exactly once", async (_state, suffix, content) => {
    await writeFile(`${target}${suffix}`, content);
    await publish(target, "body");
    expect(await readFile(target, "utf8")).toBe("body");
    expect(await entries()).toEqual(["record"]);
  });
});

describe("scoped collisions", () => {
  it("reports an exact existing leaf as a collision and leaves it untouched", async () => {
    await publish(target, "body");
    await expect(publish(target, "body")).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect(await readFile(target, "utf8")).toBe("body");
    expect(await entries()).toEqual(["record"]);
  });

  it("reclaims a crash-left committed temp alias on collision replay", async () => {
    await publish(target, "body");
    await link(target, `${target}.tmp`);
    await expect(publish(target, "body")).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect(await entries()).toEqual(["record"]);
  });
});

describe("scoped post-publication faults and retry", () => {
  it("surfaces a fault after the no-replace commit, then a retry reports the committed leaf", async () => {
    const failure = new Error("injected post-commit fault");
    await expect(publish(target, "body", { afterNoReplaceCommitForTest: async () => { throw failure; } })).rejects.toBe(failure);
    expect(await readFile(target, "utf8")).toBe("body");
    await expect(publish(target, "body")).rejects.toBeInstanceOf(AtomicWriteCollisionError);
    expect(await entries()).toEqual(["record"]);
  });

  it("preserves both aliases when the ready-link sync fails, and the same scope then recovers them", async () => {
    const failure = new Error("injected ready-link sync failure");
    await expect(publish(target, "body", {
      beforeDirectorySyncForTest: async (dir) => { if (dir === parent) throw failure; },
    })).rejects.toBe(failure);
    expect(await entries()).toEqual(["record.tmp", "record.writing"]);
    await publish(target, "body");
    expect(await entries()).toEqual(["record"]);
  });
});
