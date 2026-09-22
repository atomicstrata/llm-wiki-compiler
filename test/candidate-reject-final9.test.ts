/**
 * @file test/candidate-reject-final9.test.ts
 * @description Decision 19 regressions require concept-candidate rejection to
 * preserve occupied archive evidence and report success only after the exact
 * custody-bound archive post-state has been proved.
 */

import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveCandidate, writeCandidate, type CandidateDraft } from "../src/compiler/candidates.js";
import reviewRejectCommand from "../src/commands/review-reject.js";
import { runCLI } from "./fixtures/run-cli.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

/** Minimal pending candidate accepted by the real review command. */
function draft(): CandidateDraft {
  return { title: "Reject", slug: "reject", summary: "", sources: [], body: "body" };
}

/** Capture review output without suppressing the process exit contract. */
function captureOutput(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  return lines;
}

/** Plant one occupied archive and capture exact pending evidence. */
async function occupyArchive(candidateId: string) {
  const candidates = path.join(root.dir, ".llmwiki", "candidates");
  const pending = path.join(candidates, `${candidateId}.json`);
  const archiveDir = path.join(candidates, "archive");
  const archived = path.join(archiveDir, `${candidateId}.json`);
  await mkdir(archiveDir);
  await writeFile(archived, "historical-authority");
  return { pending, archived, before: await readFile(pending, "utf8") };
}

describe("Final9 custody-bound rejection", () => {
  afterEach(() => { process.exitCode = undefined; });

  it("preserves pending and archive bytes when the archive identity is occupied", async () => {
    const candidate = await writeCandidate(root.dir, draft());
    const occupied = await occupyArchive(candidate.id);

    expect(await archiveCandidate(root.dir, candidate.id)).toBe(false);
    expect(await readFile(occupied.pending, "utf8")).toBe(occupied.before);
    expect(await readFile(occupied.archived, "utf8")).toBe("historical-authority");
  });

  it("rejects archive-to-pending aliasing without moving or deleting the source", async () => {
    const candidate = await writeCandidate(root.dir, draft());
    const candidates = path.join(root.dir, ".llmwiki", "candidates");
    const pending = path.join(candidates, `${candidate.id}.json`);
    const before = await readFile(pending, "utf8");
    await symlink(".", path.join(candidates, "archive"));

    expect(await archiveCandidate(root.dir, candidate.id)).toBe(false);
    expect(await readFile(pending, "utf8")).toBe(before);
  });

  it("sets a nonzero exit and never prints success on an occupied archive", async () => {
    const candidate = await writeCandidate(root.dir, draft());
    const occupied = await occupyArchive(candidate.id);
    const lines = captureOutput();

    await reviewRejectCommand(candidate.id);

    expect(process.exitCode).toBe(1);
    expect(lines.join("\n")).not.toContain("Rejected candidate");
    expect(await readFile(occupied.archived, "utf8")).toBe("historical-authority");
  });

  it("fails at the real CLI boundary without claiming an occupied archive", async () => {
    const candidate = await writeCandidate(root.dir, draft());
    const occupied = await occupyArchive(candidate.id);

    const result = await runCLI(["review", "reject", candidate.id], root.dir);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Rejected candidate");
    expect(await readFile(occupied.pending, "utf8")).toBe(occupied.before);
    expect(await readFile(occupied.archived, "utf8")).toBe("historical-authority");
  });
});
