/**
 * @file test/preparations/evidence-read-bytes.test.ts
 * @description R1 (runner design v3 §5): verified byte read-back of one
 * preparation evidence object. The digest is verified over the buffered bytes
 * before they are returned, the cap is a required per-call argument with a
 * distinct `over-cap` refusal, and corrupted or absent leaves stay typed
 * refusals rather than throws or truncations.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { preparationPaths } from "../../src/preparations/paths.js";
import {
  readPreparationEvidenceBytes, writePreparationEvidenceCreateOnly,
} from "../../src/preparations/evidence-store.js";
import type { PreparationId } from "../../src/preparations/ids.js";

const root = useTempRoot();
const WS = "research";
const PREP = `prp_${"c".repeat(32)}` as PreparationId;
const LOCATION = { workspaceId: WS, preparationId: PREP };

/** Write one evidence object and return its content digest (the CAS key). */
async function writtenDigest(bytes: Buffer): Promise<string> {
  const result = await writePreparationEvidenceCreateOnly(root.dir, LOCATION, bytes);
  if (result !== "created" && result !== "same") throw new Error(`fixture write failed: ${result}`);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("readPreparationEvidenceBytes (R1)", () => {
  it("returns the exact written bytes when the digest verifies", async () => {
    const bytes = Buffer.from(JSON.stringify({ drafts: ["proposal-a"] }));
    const digest = await writtenDigest(bytes);

    const read = await readPreparationEvidenceBytes(root.dir, LOCATION, digest, 1024);
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.bytes.equals(bytes)).toBe(true);
  });

  it("refuses an object larger than the caller's cap as over-cap, not a truncation", async () => {
    const bytes = Buffer.alloc(64, 7);
    const digest = await writtenDigest(bytes);

    expect(await readPreparationEvidenceBytes(root.dir, LOCATION, digest, 63))
      .toEqual({ status: "over-cap" });
  });

  it("reports absence as absent, not a throw", async () => {
    const read = await readPreparationEvidenceBytes(
      root.dir, LOCATION, "d".repeat(64), 1024);
    expect(read.status).toBe("absent");
  });

  it("refuses corrupted bytes as mismatch before returning anything", async () => {
    const bytes = Buffer.from("original evidence body");
    const digest = await writtenDigest(bytes);
    // Corrupt in place, same byte length, so only the digest can catch it.
    const leaf = preparationPaths(root.dir, WS).evidenceFile(PREP, digest);
    await writeFile(leaf, Buffer.from("tampered evidence body"));

    const read = await readPreparationEvidenceBytes(root.dir, LOCATION, digest, 1024);
    expect(read.status).toBe("mismatch");
    expect(read).not.toHaveProperty("bytes");
  });
});
