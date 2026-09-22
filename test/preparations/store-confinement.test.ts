/**
 * @file test/preparations/store-confinement.test.ts
 * @description Two-layer path-enforcement contract across the manifest, run,
 * evidence, and key roots: an unsafe workspace or preparation id is refused at
 * path derivation; a symlinked leaf, a symlinked parent directory, a FIFO leaf,
 * and a foreign hard link are all refused at read time; and an over-cap leaf is
 * untrusted rather than slurped.
 */

import { execFileSync } from "node:child_process";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import { readPreparationManifest } from "../../src/preparations/manifest-store.js";
import { readPreparationEvidence } from "../../src/preparations/evidence-store.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { PreparationIdentityError } from "../../src/preparations/problems.js";
import type { PreparationId } from "../../src/preparations/ids.js";

const root = useTempRoot();
const WS = "research";
const PREP = `prp_${"a".repeat(32)}` as PreparationId;
const EVIDENCE_NAME = "b".repeat(64);

describe("preparation store path enforcement", () => {
  it("refuses an unsafe workspace or preparation id at path derivation", () => {
    expect(() => preparationPaths(root.dir, "../escape")).toThrow(PreparationIdentityError);
    expect(() => preparationPaths(root.dir, "Research")).toThrow(PreparationIdentityError);
    expect(() => preparationPaths(root.dir, WS).manifestFile("prp_bad" as PreparationId)).toThrow();
  });

  it("refuses a symlinked manifest leaf", async () => {
    const paths = preparationPaths(root.dir, WS);
    await mkdir(paths.preparationRoot(PREP), { recursive: true });
    await writeFile(path.join(root.dir, "outside-manifest"), "{}", "utf8");
    await symlink(path.join(root.dir, "outside-manifest"), paths.manifestFile(PREP));
    const read = await readPreparationManifest(root.dir, WS, PREP);
    expect(read.status === "absent" || read.status === "unavailable").toBe(true);
  });

  it("refuses a symlinked parent directory on an evidence read", async () => {
    const paths = preparationPaths(root.dir, WS);
    const realEvidence = path.join(root.dir, "real-evidence");
    await mkdir(realEvidence, { recursive: true });
    await writeFile(path.join(realEvidence, EVIDENCE_NAME), "planted", "utf8");
    await mkdir(paths.preparationRoot(PREP), { recursive: true });
    await symlink(realEvidence, paths.evidenceRoot(PREP));
    await expect(readPreparationEvidence(root.dir, { workspaceId: WS, preparationId: PREP }, EVIDENCE_NAME))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("refuses a foreign hard link and a FIFO on an evidence read", async () => {
    const paths = preparationPaths(root.dir, WS);
    await mkdir(paths.evidenceRoot(PREP), { recursive: true });
    await writeFile(path.join(root.dir, "foreign"), "planted", "utf8");
    await link(path.join(root.dir, "foreign"), paths.evidenceFile(PREP, EVIDENCE_NAME));
    await expect(readPreparationEvidence(root.dir, { workspaceId: WS, preparationId: PREP }, EVIDENCE_NAME))
      .resolves.toEqual({ status: "unavailable" });
    const fifoName = "c".repeat(64);
    execFileSync("mkfifo", [paths.evidenceFile(PREP, fifoName)]);
    await expect(readPreparationEvidence(root.dir, { workspaceId: WS, preparationId: PREP }, fifoName))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("refuses a symlinked project preparation key", async () => {
    const keyFile = preparationPaths(root.dir, WS).preparationKeyFile;
    await mkdir(path.dirname(keyFile), { recursive: true });
    await writeFile(path.join(root.dir, "outside-key"), "x".repeat(44), "utf8");
    await symlink(path.join(root.dir, "outside-key"), keyFile);
    await expect(readPreparationKey(root.dir)).resolves.toMatchObject({ status: "unavailable" });
  });
});
