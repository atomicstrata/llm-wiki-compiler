/**
 * @file test/review-approve-typed.test.ts
 * @description Typed-target routing for `review approve <id>` (FIX #1).
 *
 * A candidate carrying `targetEntityType` (staged via the typed planner) must be
 * routed by `review approve` through the TYPED planner — landing at
 * `wiki/<entityType>/<slug>.md`, NOT silently in `wiki/concepts/`. A typed
 * candidate in a DEFAULT project (no profile) or with an undeclared type is
 * REFUSED (exit 1, candidate retained). A default candidate (no typed target)
 * keeps the existing concepts path; that parity is pinned by review.test.ts and
 * review-approve-planner.test.ts, which must still pass unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { writeCandidate } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";

let root = "";
let originalCwd = "";

const SLUG = "linear-attention";
const BODY = "---\ntitle: Linear Attention\n---\n\n# Linear Attention\n\nBody.\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "review-typed-"));
  originalCwd = process.cwd();
  process.chdir(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

/** Write a typed `papers` candidate for SLUG and return its id. */
async function stageTypedCandidate(entityType = "papers"): Promise<string> {
  const candidate = await writeCandidate(root, {
    title: SLUG,
    slug: SLUG,
    summary: "",
    sources: [],
    body: BODY,
    targetEntityType: entityType,
  });
  return candidate.id;
}

describe("review approve — typed entity routing", () => {
  it("routes a typed papers candidate to wiki/papers/<slug>.md and clears it", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidate();

    await reviewApproveCommand(id);

    expect(await readFile(path.join(root, "wiki/papers", `${SLUG}.md`), "utf8")).toBe(BODY);
    expect(existsSync(path.join(root, "wiki/concepts", `${SLUG}.md`))).toBe(false);
    expect(existsSync(path.join(root, CANDIDATES_DIR, `${id}.json`))).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("refuses a typed candidate in a DEFAULT project (no profile) and retains it", async () => {
    const id = await stageTypedCandidate();

    await reviewApproveCommand(id);

    expect(existsSync(path.join(root, "wiki/papers", `${SLUG}.md`))).toBe(false);
    expect(existsSync(path.join(root, "wiki/concepts", `${SLUG}.md`))).toBe(false);
    expect(existsSync(path.join(root, CANDIDATES_DIR, `${id}.json`))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it("refuses a typed candidate whose type is undeclared by the profile and retains it", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidate("bogus");

    await reviewApproveCommand(id);

    expect(existsSync(path.join(root, "wiki/bogus", `${SLUG}.md`))).toBe(false);
    expect(existsSync(path.join(root, CANDIDATES_DIR, `${id}.json`))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
