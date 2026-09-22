/**
 * @file test/operation-bundles/orphan-scan-foreign-store.test.ts
 * @description The operation-bundle inventory scanner shares the
 * `.llmwiki/workspaces/<ws>/` root with the Orchestration V2 preparation store.
 * It must SKIP the preparation store's own second-level segments (`preparations`,
 * `preparation-runs`) — never flagging them as unknown operation directories,
 * which would wedge the shared recovery gate — while still flagging a genuinely
 * unknown sibling directory.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanOperationOrphans } from "../../src/operation-bundles/orphan-scan.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "orphan-foreign-"));
  const workspace = path.join(root, ".llmwiki", "workspaces", "research");
  for (const segment of ["preparations", "preparation-runs", "junk"]) {
    await mkdir(path.join(workspace, segment), { recursive: true });
  }
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("operation orphan scan foreign-store skip", () => {
  it("skips preparation directories but flags an unknown sibling", async () => {
    const scan = await scanOperationOrphans(root);
    const flagged = scan.problems.map((problem) => problem.path ?? "");
    expect(flagged.some((entry) => entry.endsWith(path.join("research", "junk")))).toBe(true);
    expect(flagged.some((entry) => entry.includes("preparation"))).toBe(false);
  });
});
