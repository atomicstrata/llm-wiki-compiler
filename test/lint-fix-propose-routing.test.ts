/**
 * @file test/lint-fix-propose-routing.test.ts
 * @description `lint --fix-propose` REFUSES a target it cannot faithfully route.
 *
 * The candidate model addresses exactly one level under `wiki/` (concepts,
 * queries, or a single typed-entity directory). A page nested deeper —
 * `wiki/research/papers/…` — would otherwise be mis-routed to `wiki/papers/…`
 * at approval, silently clobbering the wrong path. The proposal must refuse and
 * stage nothing instead of proposing a fix that lands somewhere else.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { lintFixProposeCommand } from "../src/commands/lint-fix-propose.js";
import { listCandidates } from "../src/compiler/candidates.js";

let root = "";
let originalCwd = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "fix-propose-nested-"));
  originalCwd = process.cwd();
  process.chdir(root);
  const nested = path.join(root, "wiki", "research", "papers");
  await mkdir(nested, { recursive: true });
  // A deterministically fixable link (filename ≠ slug) inside a nested page.
  await writeFile(path.join(nested, "target.md"), '---\ntitle: "Nested Target"\n---\nBody.\n');
  await writeFile(path.join(nested, "linker.md"), '---\ntitle: "Nested Linker"\n---\nUses [[Nested Target]].\n');
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("lint --fix-propose refuses an unroutable nested target", () => {
  it("refuses a fix whose page is nested below one level under wiki/, staging nothing", async () => {
    expect(await lintFixProposeCommand(1)).toBe(1);
    expect((await listCandidates(root)).length, "a mis-routable candidate was staged").toBe(0);
  });
});
