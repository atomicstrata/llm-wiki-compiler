/**
 * @file test/preparations/dry-run-purity.test.ts
 * @description Strict purity proof (design 28.2 / 31.8): a valid preview over a
 * fresh project and over an existing key epoch, and an invalid preview, each
 * leave the project root byte-identical. Every case snapshots the whole project
 * tree before and after and asserts equal.
 */

import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { previewPreparation } from "../../src/preparations/preview.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import { fixturePlan, stageRequest } from "./store-fixture.js";
import { snapshotTree } from "./inputs-fixture.js";

const root = useTempRoot();

describe("previewPreparation purity", () => {
  it("writes nothing when previewing on a fresh project", async () => {
    const before = await snapshotTree(root.dir);
    const preview = await previewPreparation(root.dir, stageRequest());
    expect(preview.status).toBe("parked");
    expect(await snapshotTree(root.dir)).toEqual(before);
  });

  it("writes nothing when previewing over an existing key epoch", async () => {
    await stagePreparationLocked(root.dir, stageRequest());
    const before = await snapshotTree(root.dir);
    const preview = await previewPreparation(root.dir, stageRequest(fixturePlan()));
    expect(preview.status === "staged" && preview.wrote).toBe(false);
    expect(await snapshotTree(root.dir)).toEqual(before);
  });

  it("writes nothing when an invalid preview fails closed", async () => {
    await stagePreparationLocked(root.dir, stageRequest());
    const before = await snapshotTree(root.dir);
    const invalid = stageRequest(fixturePlan(), { clock: { now: () => new Date(Number.NaN) } });
    await expect(previewPreparation(root.dir, invalid)).rejects.toThrow();
    expect(await snapshotTree(root.dir)).toEqual(before);
  });
});
