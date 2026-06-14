import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { writeCandidate } from "../src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("ReviewCandidate gains targetDirectory + okfPath", () => {
  it("persists targetDirectory and okfPath from the draft", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-cand-"));
    const c = await writeCandidate(dir, {
      title: "Q", slug: "my-query", summary: "s", sources: ["okf:bundle"],
      body: "---\ntitle: Q\n---\n\nbody\n",
      reviewMode: "imported", heldReasons: [{ code: "imported-okf" }],
      targetDirectory: "queries", okfPath: "queries/my-query.md",
    });
    expect(c.targetDirectory).toBe("queries");
    expect(c.okfPath).toBe("queries/my-query.md");
    const onDisk = JSON.parse(await readFile(path.join(dir, ".llmwiki/candidates", `${c.id}.json`), "utf-8"));
    expect(onDisk.targetDirectory).toBe("queries");
    expect(onDisk.okfPath).toBe("queries/my-query.md");
  });
});
