/**
 * @file test/pending-embeddings-lint-cli.test.ts
 * @description SUBPROCESS (real-CLI) integration coverage that the durable
 * pending-embedding refresh marker is SURFACED by the real `llmwiki lint` binary
 * (`dist/cli.js` via `runCLI`), mirroring the journal-health real-CLI assertions
 * in `compile-reroute-cli.test.ts`. A planted marker → stdout carries the stable
 * `embeddings-refresh-pending:` code (a warning, so lint still exits 0 per the
 * lint convention — only errors exit nonzero); a clean project → stdout does NOT.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { CONCEPTS_DIR, LLMWIKI_DIR, PENDING_EMBEDDINGS_FILE } from "../src/utils/constants.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pending-embed-lint-cli-"));
  await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pending embeddings — real-CLI lint surfacing", () => {
  it("lint reports embeddings-refresh-pending when a marker exists (warning → exit 0)", async () => {
    await writePendingEmbeddings(root, [
      { pageId: "concepts/a", attempts: 0 },
      { pageId: "concepts/b", attempts: 1 },
    ]);
    const result = await runCLI(["lint"], root);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("embeddings-refresh-pending:");
  }, 30_000);

  it("lint does NOT report it on a clean project", async () => {
    const result = await runCLI(["lint"], root);
    expectCLIExit(result, 0);
    expect(result.stdout).not.toContain("embeddings-refresh-pending");
  }, 30_000);

  it("lint reports embeddings-refresh-unavailable for an unreadable (corrupt) marker", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(path.join(root, PENDING_EMBEDDINGS_FILE), "{not json", "utf-8");
    const result = await runCLI(["lint"], root);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("embeddings-refresh-unavailable:");
  }, 30_000);
});
