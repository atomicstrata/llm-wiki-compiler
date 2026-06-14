/**
 * Integration test for `llmwiki export --target okf --out <dir>`.
 *
 * Spawns the compiled CLI as a subprocess and asserts that the OKF bundle
 * directory is created with the expected structure (index.md + per-page docs).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "okf-cli-"));
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "concepts", "rag.md"),
    `---\ntitle: RAG\nsummary: Grounded.\nkind: concept\n---\nBody.\n`,
    "utf-8",
  );
});

describe("export --target okf", () => {
  it("writes a bundle directory to --out and reports success", async () => {
    const out = path.join(root, "bundle");
    const res = await runCLI(["export", "--target", "okf", "--out", out], root);
    expectCLIExit(res, 0);
    await access(path.join(out, "index.md"));
    await access(path.join(out, "concepts", "rag.md"));
  });
});
