/**
 * @file test/operation-bundles/evidence-store.test.ts
 * @description Task 4 contract tests for bounded, immutable run-evidence
 * blobs and the non-persisting evidence-over-limit reference.
 */

import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MAX_RUN_EVIDENCE_BLOB_BYTES, MAX_RUN_EVIDENCE_BYTES } from "../../src/operation-bundles/constants.js";
import { mintOperationRunId } from "../../src/operation-bundles/ids.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import { writeRunEvidenceCreateOnly } from "../../src/operation-bundles/evidence-store.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Return the exact digest reference returned for one byte sequence. */
function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("run-evidence store", () => {
  it("creates an immutable run-owned evidence reference and exactly replays it", async () => {
    const runId = mintOperationRunId(), bytes = Buffer.from("evidence");
    const location = { workspaceId: "research", runId, type: "observation", provenance: "controller" };

    const created = await writeRunEvidenceCreateOnly(root.dir, location, bytes);
    await expect(writeRunEvidenceCreateOnly(root.dir, location, bytes)).resolves.toEqual(created);
    expect(created).toMatchObject({ digest: digest(bytes), byteCount: bytes.byteLength, type: "observation", provenance: "controller" });
    await expect(access(operationPaths(root.dir, "research").evidenceFile(runId, digest(bytes).slice("sha256:".length))))
      .resolves.toBeUndefined();
  });

  it("returns a fixed over-limit reference without writing a blob", async () => {
    const runId = mintOperationRunId(), bytes = Buffer.alloc(MAX_RUN_EVIDENCE_BLOB_BYTES + 1, 0x61);
    const location = { workspaceId: "research", runId, type: "observation", provenance: "controller" };

    await expect(writeRunEvidenceCreateOnly(root.dir, location, bytes)).resolves.toEqual({
      kind: "evidence-over-limit", digest: digest(bytes), byteCount: bytes.byteLength,
      type: "observation", provenance: "controller", excerpt: "a".repeat(256),
    });
    const file = operationPaths(root.dir, "research").evidenceFile(runId, digest(bytes).slice("sha256:".length));
    await expect(access(file)).rejects.toThrow();
  });

  it("does not duplicate the complete over-limit input buffer", async () => {
    const bytes = Buffer.alloc(MAX_RUN_EVIDENCE_BLOB_BYTES + 1, 0x61);
    const from = vi.spyOn(Buffer, "from");
    const location = {
      workspaceId: "research", runId: mintOperationRunId(),
      type: "observation", provenance: "controller",
    };
    try {
      await writeRunEvidenceCreateOnly(root.dir, location, bytes);
      expect(from.mock.calls.some(([value]) => value === bytes)).toBe(false);
    } finally {
      from.mockRestore();
    }
  });

  it("refuses evidence above the explicit observation ceiling", async () => {
    const bytes = Buffer.alloc(MAX_RUN_EVIDENCE_BYTES + 1);
    const location = {
      workspaceId: "research", runId: mintOperationRunId(),
      type: "observation", provenance: "controller",
    };

    await expect(writeRunEvidenceCreateOnly(root.dir, location, bytes))
      .rejects.toThrow(/observation.*cap|evidence.*cap/i);
  });

  it.each([
    ["workspace", { workspaceId: "../foreign", type: "observation", provenance: "controller" }],
    ["run", { workspaceId: "research", runId: "opr_invalid", type: "observation", provenance: "controller" }],
    ["type", { workspaceId: "research", type: "", provenance: "controller" }],
    ["provenance", { workspaceId: "research", type: "observation", provenance: "" }],
  ])("validates %s before reporting evidence as over-limit", async (_caseName, override) => {
    const location = { runId: mintOperationRunId(), ...override };
    const bytes = Buffer.alloc(MAX_RUN_EVIDENCE_BLOB_BYTES + 1);

    await expect(writeRunEvidenceCreateOnly(root.dir, location as never, bytes)).rejects.toThrow();
  });

  it("binds evidence metadata and storage to one private byte snapshot", async () => {
    const runId = mintOperationRunId(), bytes = Buffer.from("original evidence");
    const expected = Buffer.from(bytes);
    const location = { workspaceId: "research", runId, type: "observation", provenance: "controller" };

    const writing = writeRunEvidenceCreateOnly(root.dir, location, bytes);
    queueMicrotask(() => bytes.fill(0x78));

    await expect(writing).resolves.toMatchObject({ digest: digest(expected), byteCount: expected.byteLength });
    const file = operationPaths(root.dir, "research").evidenceFile(runId, digest(expected).slice("sha256:".length));
    expect(await readFile(file)).toEqual(expected);
  });

  it("derives the over-limit digest and excerpt from the same bounded observation", async () => {
    const bytes = Buffer.alloc(MAX_RUN_EVIDENCE_BLOB_BYTES + 1, 0x61);
    const location = {
      workspaceId: "research", runId: mintOperationRunId(),
      type: "observation", provenance: "controller",
    };

    await expect(writeRunEvidenceCreateOnly(root.dir, location, bytes)).resolves.toMatchObject({
      digest: digest(bytes), excerpt: "a".repeat(256),
    });
  });
});
