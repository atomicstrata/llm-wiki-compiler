import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCandidate, listCandidates } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";

let dir: string; const cwd = process.cwd();
afterEach(async () => { process.chdir(cwd); if (dir) await rm(dir, { recursive: true, force: true }); });

describe("approve respects targetDirectory", () => {
  it("writes a queries candidate to wiki/queries/", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-approve-"));
    await writeCandidate(dir, {
      title: "Q", slug: "trends", summary: "s", sources: ["okf:b"],
      body: "---\ntitle: Q\nsummary: s\n---\n\nReal body content.\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      targetDirectory: "queries", okfPath: "queries/trends.md",
    });
    process.chdir(dir);
    const [c] = await listCandidates(dir);
    await reviewApproveCommand(c.id);
    expect((await stat(path.join(dir, "wiki/queries/trends.md"))).isFile()).toBe(true);
  });
});
