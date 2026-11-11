/**
 * @file test/storage/preparation-manifest-create-binding.test.ts
 * @description The create-only manifest write as ONE body over its two project
 * calls, `writePreparationManifestCreateOnlyWith` over
 * `PreparationManifestCreateSteps`, with no project directory touched by the
 * body. This file uses the body, which exists only after the write was given its
 * steps, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. A real manifest is staged once by the host; memory steps then
 * answer the no-replace creation and the collision read and log each call, so the
 * create-then-read order, the exact-replay rule, each conflict, the refusal of an
 * invalid manifest before any step and a creation fault's propagation are pinned.
 * The composition is shown reading back through the manifest store's own read
 * body over memory leaves, and the root form handing the incumbent no-replace
 * write its root, then reading the manifest staged under that root.
 *
 * NOT SHOWN HERE: the durable no-replace primitive and the confined read; the
 * atomic-write, manifest-store and stage suites show those.
 */

import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { MAX_PREPARATION_MANIFEST_BYTES } from "../../src/preparations/constants.js";
import {
  preparationManifestCreateStepsOver, writePreparationManifestCreateOnly, writePreparationManifestCreateOnlyWith,
  type PreparationManifestCreateSteps, type PreparationManifestRead,
} from "../../src/preparations/manifest-store.js";
import type { PreparationManifestV1 } from "../../src/preparations/manifest-parse.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import * as atomicWriteModule from "../../src/utils/atomic-write.js";
import { makeTempRoot } from "../fixtures/temp-root.js";
import { stageRequest } from "../preparations/store-fixture.js";

// ONE root for the file, made in `beforeAll`: `useTempRoot` sets its dir only in
// `beforeEach`, after `beforeAll` has already staged.
const root = { dir: "" };
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { if (root.dir) await rm(root.dir, { recursive: true, force: true }); });

let MANIFEST: PreparationManifestV1;
beforeAll(async () => {
  root.dir = await makeTempRoot("manifest-create-binding");
  const staged = await stagePreparationLocked(root.dir, stageRequest());
  if (staged.status !== "staged") throw new Error(`fixture did not stage: ${staged.status}`);
  MANIFEST = staged.manifest;
});

/** Memory project steps answering `create` and then `read`, each call logged. */
function stepsOf(log: string[], create: "created" | "collision" | Error, read: PreparationManifestRead = { status: "absent" }): PreparationManifestCreateSteps {
  return {
    createLeaf: async (workspaceId, preparationId, bytes) => {
      log.push(`create ${workspaceId} ${preparationId} ${bytes.byteLength}`);
      if (create instanceof Error) throw create;
      return create;
    },
    readManifest: async (workspaceId, preparationId) => { log.push(`read ${workspaceId} ${preparationId}`); return read; },
  };
}

/** The log lines one create and one collision read of `manifest` produce. */
function callsFor(manifest: PreparationManifestV1, withRead: boolean): string[] {
  const create = (call: string) => call.startsWith("create");
  const lines = [`create ${manifest.workspaceId} ${manifest.preparationId}`, `read ${manifest.workspaceId} ${manifest.preparationId}`];
  return withRead ? lines : lines.filter(create);
}

/** Strip the byte count so a log compares with {@link callsFor}. */
const withoutBytes = (log: string[]) => log.map((call) => call.startsWith("create") ? call.replace(/ \d+$/, "") : call);

describe("the create-only manifest write over its project steps", () => {
  it("W1 creates the canonical leaf and reads nothing", async () => {
    const log: string[] = [];
    expect(await writePreparationManifestCreateOnlyWith(stepsOf(log, "created"), MANIFEST)).toBe("created");
    expect(withoutBytes(log)).toEqual(callsFor(MANIFEST, false));
  });

  it("W2 a collision with the same canonical manifest is an exact replay", async () => {
    const log: string[] = [];
    expect(await writePreparationManifestCreateOnlyWith(stepsOf(log, "collision", { status: "ok", manifest: MANIFEST }), MANIFEST)).toBe("same");
    expect(withoutBytes(log)).toEqual(callsFor(MANIFEST, true));
  });

  it("W3 a collision with a different, absent or invalid manifest is a conflict naming the read", async () => {
    const other = { ...MANIFEST, createdAt: "2000-01-01T00:00:00.000Z" } as PreparationManifestV1;
    const reads: PreparationManifestRead[] = [{ status: "ok", manifest: other }, { status: "absent" }, { status: "invalid", detail: "x" }];
    const thrown = await Promise.all(reads.map((read) => writePreparationManifestCreateOnlyWith(stepsOf([], "collision", read), MANIFEST).catch((error: Error) => error.message)));
    expect(thrown).toEqual(["preparation manifest conflict: ok", "preparation manifest conflict: absent", "preparation manifest conflict: invalid"]);
  });

  it("W4 an invalid manifest is refused before any step; a creation fault propagates without the read", async () => {
    const log: string[] = [];
    const invalid = { ...MANIFEST, unexpected: true } as PreparationManifestV1;
    await expect(writePreparationManifestCreateOnlyWith(stepsOf(log, "created"), invalid)).rejects.toThrow();
    expect(log).toEqual([]);
    await expect(writePreparationManifestCreateOnlyWith(stepsOf(log, new Error("disk")), MANIFEST)).rejects.toThrow("disk");
    expect(withoutBytes(log)).toEqual(callsFor(MANIFEST, false));
  });
});

describe("the composition and the root form", () => {
  it("B1 the composition hands the caller's mechanism the bytes and reads back through the store's own body over its leaves", async () => {
    const log: string[] = [];
    const leaves = { manifestLeavesIn: (workspaceId: string) => async (preparationId: string, maxBytes: number) => {
      log.push(`leaf ${workspaceId} ${preparationId} ${maxBytes}`);
      return { kind: "ok" as const, body: canonicalBytes(MANIFEST) };
    } };
    const steps = preparationManifestCreateStepsOver(leaves, stepsOf(log, "collision").createLeaf);
    expect(await writePreparationManifestCreateOnlyWith(steps, MANIFEST)).toBe("same");
    expect(withoutBytes(log)).toEqual([...callsFor(MANIFEST, false), `leaf ${MANIFEST.workspaceId} ${MANIFEST.preparationId} ${MAX_PREPARATION_MANIFEST_BYTES}`]);
  });

  it("B2 the root form reaches the incumbent no-replace write with its root, then reads the root's own manifest", async () => {
    const write = vi.spyOn(atomicWriteModule, "atomicWriteNoReplaceDurable").mockRejectedValue(new atomicWriteModule.AtomicWriteCollisionError());
    expect(await writePreparationManifestCreateOnly(root.dir, MANIFEST)).toBe("same");
    expect([write.mock.calls.length, String(write.mock.calls[0]?.[0]).startsWith(`${root.dir}/`), write.mock.calls[0]?.[2]]).toEqual([
      1, true, { confineRoot: root.dir, exactParent: true, mode: 0o600 },
    ]);
  });
});
