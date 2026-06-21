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
import { readState } from "../src/utils/state.js";
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
  return stageTypedCandidateBody(BODY, entityType);
}

/** Write a typed candidate with an explicit body + type, returning its id. */
async function stageTypedCandidateBody(body: string, entityType: string): Promise<string> {
  const candidate = await writeCandidate(root, {
    title: SLUG,
    slug: SLUG,
    summary: "",
    sources: [],
    body,
    targetEntityType: entityType,
  });
  return candidate.id;
}

/**
 * Assert a candidate was REFUSED: the page at `pageRelDir/<slug>.md` was not
 * written, the candidate `id` is retained, and the process exit code is 1.
 */
function expectRefused(pageRelDir: string, id: string): void {
  expect(existsSync(path.join(root, pageRelDir, `${SLUG}.md`))).toBe(false);
  expect(existsSync(path.join(root, CANDIDATES_DIR, `${id}.json`))).toBe(true);
  expect(process.exitCode).toBe(1);
}

/**
 * Assert a candidate was APPROVED: the page at `pageRelDir/<slug>.md` holds
 * exactly `body`, the candidate `id` is cleared, and the exit code is 0.
 */
async function expectApproved(pageRelDir: string, id: string, body: string): Promise<void> {
  expect(await readFile(path.join(root, pageRelDir, `${SLUG}.md`), "utf8")).toBe(body);
  expect(existsSync(path.join(root, CANDIDATES_DIR, `${id}.json`))).toBe(false);
  expect(process.exitCode ?? 0).toBe(0);
}

describe("review approve — typed entity routing", () => {
  it("routes a typed papers candidate to wiki/papers/<slug>.md and clears it", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidate();

    await reviewApproveCommand(id);

    await expectApproved("wiki/papers", id, BODY);
    expect(existsSync(path.join(root, "wiki/concepts", `${SLUG}.md`))).toBe(false);
  });

  it("refuses a typed candidate in a DEFAULT project (no profile) and retains it", async () => {
    const id = await stageTypedCandidate();

    await reviewApproveCommand(id);

    expectRefused("wiki/papers", id);
    expect(existsSync(path.join(root, "wiki/concepts", `${SLUG}.md`))).toBe(false);
  });

  it("refuses a typed candidate whose type is undeclared by the profile and retains it", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidate("bogus");

    await reviewApproveCommand(id);

    expectRefused("wiki/bogus", id);
  });
});

/** A valid `experiments` body: required `runtime` field, NO `title`. */
const NO_TITLE_EXPERIMENT_BODY = "---\nruntime: cpu\n---\n\n# Ablation\n\nBody.\n";
/** A `papers` body missing its required `title` field. */
const NO_TITLE_PAPER_BODY = "---\nvenue: NeurIPS\n---\n\n# Paper\n\nBody.\n";

describe("review approve — typed candidates skip the default title validator", () => {
  it("approves a typed experiments candidate with valid fields but no title", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidateBody(NO_TITLE_EXPERIMENT_BODY, "experiments");

    await reviewApproveCommand(id);

    await expectApproved("wiki/experiments", id, NO_TITLE_EXPERIMENT_BODY);
  });

  it("still refuses a typed candidate that violates its field contract", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidateBody(NO_TITLE_PAPER_BODY, "papers");

    await reviewApproveCommand(id);

    expectRefused("wiki/papers", id);
  });

  it("still rejects a DEFAULT candidate missing its title via validateWikiPage", async () => {
    const candidate = await writeCandidate(root, {
      title: SLUG,
      slug: SLUG,
      summary: "",
      sources: [],
      body: NO_TITLE_PAPER_BODY,
    });

    await reviewApproveCommand(candidate.id);

    expectRefused("wiki/concepts", candidate.id);
  });
});

describe("review approve — typed read-integration note (loud + honest)", () => {
  /** Capture every console.log argument as one joined string for substring asserts. */
  function captureLog(): () => string {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    return () => lines.join("\n");
  }

  it("prints the integration-pending note after a typed approval", async () => {
    await buildResearchLiteProject(root);
    const id = await stageTypedCandidate();
    const readLog = captureLog();

    await reviewApproveCommand(id);

    const out = readLog();
    expect(out).toContain("not yet included in interlinking");
    expect(out).toContain("wiki/papers/linear-attention.md");
  });

  it("does NOT print the note for a DEFAULT (concepts) approval", async () => {
    const candidate = await writeCandidate(root, {
      title: SLUG, slug: SLUG, summary: "", sources: [], body: BODY,
    });
    const readLog = captureLog();

    await reviewApproveCommand(candidate.id);

    expect(readLog()).not.toContain("not yet included in interlinking");
  });
});

/** A sourceStates map carrying one source entry for `src.md`. */
const SOURCE_STATES = {
  "src.md": { hash: "h1", concepts: [], compiledAt: "2026-01-01T00:00:00.000Z" },
};

describe("review approve — state tail skipped for typed candidates (F4)", () => {
  it("does NOT write a typed candidate's slug into any source's concepts list", async () => {
    await buildResearchLiteProject(root);
    const candidate = await writeCandidate(root, {
      title: SLUG, slug: SLUG, summary: "", sources: ["src.md"], body: BODY,
      targetEntityType: "papers", sourceStates: SOURCE_STATES,
    });

    await reviewApproveCommand(candidate.id);

    await expectApproved("wiki/papers", candidate.id, BODY);
    const state = await readState(root);
    expect(state.sources).toEqual({}); // no concepts pollution from the typed slug
  });

  it("still persists source states for a DEFAULT candidate (unchanged)", async () => {
    const candidate = await writeCandidate(root, {
      title: SLUG, slug: SLUG, summary: "", sources: ["src.md"], body: BODY,
      sourceStates: SOURCE_STATES,
    });

    await reviewApproveCommand(candidate.id);

    const state = await readState(root);
    expect(state.sources["src.md"]?.concepts).toEqual([SLUG]);
  });
});
