import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCandidate, listCandidates } from "../src/compiler/candidates.js";
import reviewShowCommand from "../src/commands/review-show.js";

let dir: string; const cwd = process.cwd();
afterEach(async () => { process.chdir(cwd); vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });

describe("review show surfaces okfPath", () => {
  it("prints the candidate's okfPath", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-show-"));
    await writeCandidate(dir, {
      title: "X", slug: "x", summary: "s", sources: ["okf:b"],
      body: "---\ntitle: X\n---\n\nbody\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      okfPath: "concepts/x.md",
    });
    process.chdir(dir);
    const [c] = await listCandidates(dir);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await reviewShowCommand(c.id);
    const out = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(out).toContain("concepts/x.md");
  });
});
