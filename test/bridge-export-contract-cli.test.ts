/**
 * Subprocess-level integration tests for the bridge contract additions
 * to `llmwiki export --target json`.
 *
 * Coverage:
 *
 *  - `--project-id <id>` lands in the JSON envelope.
 *  - Invalid `--project-id` values cause a non-zero exit with a clear
 *    error message and DO NOT write `wiki.json`.
 *  - Default export (no flag) still produces a valid envelope without
 *    `projectId`.
 *
 * `dist/cli.js` is built once via vitest globalSetup; see
 * test/global-setup.ts.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { rm, readFile, access } from "fs/promises";
import { runCLI, expectCLIExit, expectCLIFailure } from "./fixtures/run-cli.js";
import { writePage } from "./fixtures/write-page.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

const EXPORT_DIR = "dist/exports";

interface BridgeEnvelope {
  exportedAt: string;
  pageCount: number;
  projectId?: string;
  pages: { slug: string; path: string; freshnessStatus: string }[];
}

async function makeWiki(suffix: string): Promise<string> {
  const root = await makeTempRoot(`bridge-cli-${suffix}`);
  await writePage(
    path.join(root, "wiki/concepts"),
    "retrieval",
    { title: "Retrieval", summary: "x", kind: "concept" },
    "Retrieval is selective lookup.\n",
  );
  return root;
}

async function readJsonExport(root: string): Promise<BridgeEnvelope> {
  const raw = await readFile(path.join(root, EXPORT_DIR, "wiki.json"), "utf-8");
  return JSON.parse(raw) as BridgeEnvelope;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("llmwiki export --target json (bridge contract CLI)", () => {
  it("embeds --project-id in the JSON envelope", async () => {
    const root = await makeWiki("ok");
    try {
      const result = await runCLI(
        ["export", "--target", "json", "--project-id", "my-kb"],
        root,
      );
      expectCLIExit(result, 0);
      const env = await readJsonExport(root);
      expect(env.projectId).toBe("my-kb");
      expect(env.pages[0].path).toBe("wiki/concepts/retrieval.md");
      expect(env.pages[0].freshnessStatus).toBe("unverified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits projectId when the flag is not supplied", async () => {
    const root = await makeWiki("default");
    try {
      const result = await runCLI(["export", "--target", "json"], root);
      expectCLIExit(result, 0);
      const env = await readJsonExport(root);
      expect(env.projectId).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a path-traversal projectId and writes nothing", async () => {
    const root = await makeWiki("traversal");
    try {
      const result = await runCLI(
        ["export", "--target", "json", "--project-id", "../escape"],
        root,
      );
      expectCLIFailure(result);
      expect(result.stderr + result.stdout).toMatch(/Invalid projectId/);
      const wrote = await fileExists(path.join(root, EXPORT_DIR, "wiki.json"));
      expect(wrote).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversize projectId at the CLI boundary", async () => {
    const root = await makeWiki("oversize");
    try {
      const result = await runCLI(
        ["export", "--target", "json", "--project-id", "a".repeat(64)],
        root,
      );
      expectCLIFailure(result);
      expect(result.stderr + result.stdout).toMatch(/Invalid projectId/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
