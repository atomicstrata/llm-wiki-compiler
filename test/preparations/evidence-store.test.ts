/**
 * @file test/preparations/evidence-store.test.ts
 * @description Immutable evidence CAS contract: create-only write plus exact
 * replay, a streaming digest-verified read, a byte/digest mismatch reported
 * distinctly from absence, an over-cap read refused, and a planted FIFO leaf
 * that returns immediately (nonblocking) instead of hanging the reader.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { readPreparationEvidence, writePreparationEvidenceCreateOnly } from "../../src/preparations/evidence-store.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import type { PreparationId } from "../../src/preparations/ids.js";

const root = useTempRoot();
const WS = "research";
const PREP = `prp_${"a".repeat(32)}` as PreparationId;
const location = { workspaceId: WS, preparationId: PREP };

/** The bare-hex digest of some bytes. */
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Ensure the evidence directory exists before planting a raw leaf. */
async function evidenceDir(dir: string): Promise<string> {
  const target = preparationPaths(dir, WS).evidenceRoot(PREP);
  await mkdir(target, { recursive: true });
  return target;
}

describe("preparation evidence store", () => {
  it("creates an immutable evidence blob and exactly replays it", async () => {
    const bytes = Buffer.from("host-authored-evidence");
    await expect(writePreparationEvidenceCreateOnly(root.dir, location, bytes)).resolves.toBe("created");
    await expect(writePreparationEvidenceCreateOnly(root.dir, location, bytes)).resolves.toBe("same");
    await expect(readPreparationEvidence(root.dir, location, digest(bytes))).resolves.toEqual({ status: "ok", byteCount: bytes.byteLength });
  });

  it("reports absence and a byte/digest mismatch distinctly", async () => {
    const dir = await evidenceDir(root.dir);
    await expect(readPreparationEvidence(root.dir, location, digest(Buffer.from("missing")))).resolves.toEqual({ status: "absent" });
    const wrongName = digest(Buffer.from("claimed"));
    await writeFile(path.join(dir, wrongName), "actual-different-bytes", "utf8");
    await expect(readPreparationEvidence(root.dir, location, wrongName)).resolves.toEqual({ status: "mismatch" });
  });

  it("refuses an over-cap read", async () => {
    const bytes = Buffer.alloc(4096, 0x61);
    await writePreparationEvidenceCreateOnly(root.dir, location, bytes);
    await expect(readPreparationEvidence(root.dir, location, digest(bytes), 1024)).resolves.toEqual({ status: "unavailable" });
  });

  it("returns immediately on a planted FIFO leaf instead of blocking", async () => {
    const dir = await evidenceDir(root.dir);
    const name = digest(Buffer.from("fifo"));
    execFileSync("mkfifo", [path.join(dir, name)]);
    await expect(readPreparationEvidence(root.dir, location, name)).resolves.toEqual({ status: "unavailable" });
  });
});
