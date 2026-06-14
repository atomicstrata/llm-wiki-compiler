import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCandidate, listCandidates } from "../src/compiler/candidates.js";
import reviewShowCommand from "../src/commands/review-show.js";

let dir: string; const cwd = process.cwd();
afterEach(async () => { process.chdir(cwd); vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }); });

/** Stage a candidate, run reviewShowCommand under a console.log spy, return joined output. */
async function showCapture(prefix: string, draft: Parameters<typeof writeCandidate>[1]): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), prefix));
  await writeCandidate(dir, draft);
  process.chdir(dir);
  const [c] = await listCandidates(dir);
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  await reviewShowCommand(c.id);
  return spy.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("review show surfaces okfPath", () => {
  it("prints the candidate's okfPath", async () => {
    const out = await showCapture("okf-show-", {
      title: "X", slug: "x", summary: "s", sources: ["okf:b"],
      body: "---\ntitle: X\n---\n\nbody\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      okfPath: "concepts/x.md",
    });
    expect(out).toContain("concepts/x.md");
  });
});

describe("review show flags imported candidates as untrusted", () => {
  it("prints an untrusted-content banner for an imported candidate", async () => {
    const out = await showCapture("okf-banner-", {
      title: "X", slug: "x", summary: "s", sources: ["okf:b"],
      body: "---\ntitle: X\n---\n\nbody\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
    });
    expect(out).toMatch(/untrusted/i);
    expect(out).toMatch(/external OKF/i);
  });

  it("does NOT print the banner for a non-imported (forced) candidate", async () => {
    const out = await showCapture("okf-noband-", {
      title: "X", slug: "x", summary: "s", sources: ["src.md"],
      body: "---\ntitle: X\n---\n\nbody\n",
      reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }],
    });
    expect(out).not.toMatch(/untrusted/i);
  });
});
