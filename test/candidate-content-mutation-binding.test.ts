/**
 * @file test/candidate-content-mutation-binding.test.ts
 * @description Direct-write candidate reconciliation must keep each selected
 * record paired with its store-owned filename through validation and deletion.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CandidateIdentityMismatchError,
  deleteCandidateBySlug,
  UnsafeCandidateIdError,
} from "../src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import { snapshotCandidateQueue } from "./fixtures/candidate-queue.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const TARGET_SLUG = "target-topic";
const OTHER_SLUG = "other-topic";

interface CandidateFixture {
  readonly fileId: string;
  readonly recordId?: string;
  readonly slug?: string;
  readonly generatedAt?: string;
}

/** Plant one complete pending record with separately controlled identities. */
async function plantCandidate(fixture: CandidateFixture): Promise<void> {
  const dir = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const candidate = {
    id: fixture.recordId ?? fixture.fileId,
    title: "Fixture",
    slug: fixture.slug ?? TARGET_SLUG,
    summary: "",
    sources: [],
    body: "---\ntitle: Fixture\n---\nBody\n",
    generatedAt: fixture.generatedAt ?? "2026-01-01T00:00:00.000Z",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
  };
  await writeFile(path.join(dir, `${fixture.fileId}.json`), JSON.stringify(candidate));
}

/** Assert deletion refuses with the expected type and preserves every byte. */
async function expectDeleteRefusal(errorType: new (...args: any[]) => Error): Promise<void> {
  const before = await snapshotCandidateQueue(root.dir);
  await expect(deleteCandidateBySlug(root.dir, TARGET_SLUG)).rejects.toBeInstanceOf(errorType);
  expect(await snapshotCandidateQueue(root.dir)).toEqual(before);
}

describe("content-selected candidate deletion", () => {
  it("refuses a record that names an unrelated pending filename", async () => {
    await plantCandidate({ fileId: "selected-file", recordId: "victim-file" });
    await plantCandidate({ fileId: "victim-file", slug: OTHER_SLUG });

    await expectDeleteRefusal(CandidateIdentityMismatchError);
  });

  it("refuses a record whose asserted destination is absent", async () => {
    await plantCandidate({ fileId: "selected-file", recordId: "absent-file" });

    await expectDeleteRefusal(CandidateIdentityMismatchError);
  });

  it("validates a mixed batch before deleting any valid entry", async () => {
    await plantCandidate({ fileId: "valid-file" });
    await plantCandidate({
      fileId: "mismatch-file",
      recordId: "absent-file",
      generatedAt: "2026-01-02T00:00:00.000Z",
    });

    await expectDeleteRefusal(CandidateIdentityMismatchError);
  });

  it("deletes every valid selected filename and leaves unrelated bytes", async () => {
    await plantCandidate({ fileId: "first-file" });
    await plantCandidate({ fileId: "second-file", generatedAt: "2026-01-02T00:00:00.000Z" });
    await plantCandidate({ fileId: "unrelated-file", slug: OTHER_SLUG });
    const unrelated = (await snapshotCandidateQueue(root.dir))["unrelated-file.json"];

    await expect(deleteCandidateBySlug(root.dir, TARGET_SLUG)).resolves.toBe(true);

    expect(await snapshotCandidateQueue(root.dir)).toEqual({ "unrelated-file.json": unrelated });
  });

  it("leaves an unrelated mismatch nonblocking and byte-identical", async () => {
    await plantCandidate({ fileId: "target-file" });
    await plantCandidate({ fileId: "other-file", recordId: "other-record", slug: OTHER_SLUG });
    const before = await snapshotCandidateQueue(root.dir);

    await expect(deleteCandidateBySlug(root.dir, TARGET_SLUG)).resolves.toBe(true);

    expect(await snapshotCandidateQueue(root.dir)).toEqual({ "other-file.json": before["other-file.json"] });
  });

  it.each([
    ["reserved filename", "BND_legacy-file", "ordinary-record"],
    ["reserved record id", "ordinary-file", "BND_legacy-record"],
  ])("refuses a selected %s before deletion", async (_label, fileId, recordId) => {
    await plantCandidate({ fileId, recordId });

    await expectDeleteRefusal(UnsafeCandidateIdError);
  });
});
