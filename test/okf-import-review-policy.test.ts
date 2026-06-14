import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCandidate, listCandidates } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("imported mode/reason survive candidate sanitization", () => {
  it("keeps reviewMode=imported and code=imported-okf after listCandidates", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-mode-"));
    await writeCandidate(dir, {
      title: "A", slug: "a", summary: "s", sources: ["okf:b"], body: "---\ntitle: A\n---\n\nx\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
    });
    const [c] = await listCandidates(dir);
    expect(c.reviewMode).toBe("imported");
    expect(c.heldReasons[0].code).toBe("imported-okf");
  });
});
