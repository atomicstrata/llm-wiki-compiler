/**
 * @file test/event-store-integration.test.ts
 * @description Subprocess-level integration tests for the hash-chained event store
 * (CLP 4b), proving the three headline guarantees via the REAL CLI binary:
 *
 *  1. TAMPER FAILS CLOSED: swapping two records in `wiki/graph/events.jsonl` causes
 *     `llmwiki lint` to exit non-zero and surface an `event-chain-broken` finding.
 *  2. DEFAULT EMITS NO EVENTS: a default (no-profile) project has no event store
 *     and `llmwiki lint` exits 0 with no event problem in its output.
 *  3. STATUS SURFACES THE PROBLEM: on the tampered project, running `llmwiki next
 *     --json` after lint reveals the lint-error count is non-zero (event-chain
 *     broken is visible in the status surface, not silently swallowed).
 *
 * Event seeding uses the in-process SDK (`appendEvent`) since there is no CLI
 * command for relation/event creation; the ASSERTION is always the CLI subprocess.
 * This mirrors the established pattern in test/lint-cache-integration.test.ts and
 * test/freshness-lint-next-e2e.test.ts where in-process seeding feeds CLI assertions.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCLI, expectCLIExit, expectCLIFailure } from "./fixtures/run-cli.js";
import { buildResearchLiteRelationsProject } from "./fixtures/profile-fixtures.js";
import { appendEvent } from "../src/events/store.js";
import { EVENTS_FILE, CONCEPTS_DIR } from "../src/utils/constants.js";

/** Minimal event input for seeding a relation-create event. */
const evt = (n: string) => ({
  type: "relation-create" as const,
  origin: "sdk",
  payload: { n },
  at: "2024-01-01T00:00:00Z",
});

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "event-store-int-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/**
 * Seed a non-default relations project with two events, then swap the first two
 * data records (leaving the header in place) to corrupt the chain.
 */
async function buildTamperedProject(): Promise<void> {
  await buildResearchLiteRelationsProject(root);
  // Seed events in-process; CLI assertions follow.
  await appendEvent(root, evt("a"));
  await appendEvent(root, evt("b"));
  const raw = await readFile(path.join(root, EVENTS_FILE), "utf8");
  const [header, r1, r2] = raw.split("\n").filter(Boolean);
  // Swap r1 ↔ r2 to break the prevHash chain link.
  await writeFile(path.join(root, EVENTS_FILE), [header, r2, r1].join("\n") + "\n");
}

describe("event-store CLI integration — tamper fails closed", () => {
  it("llmwiki lint exits non-zero and surfaces event-chain-broken on a tampered store", async () => {
    await buildTamperedProject();

    const result = await runCLI(["lint"], root);

    expectCLIFailure(result);
    // The lint command prints the finding MESSAGE, not the rule ID. The chain-broken
    // message is "chain link broken at event N" or "head anchor … does not match last event".
    // Either confirms the event-chain-broken rule fired at the CLI surface.
    expect(result.stdout + result.stderr).toMatch(/chain link broken|head anchor .* does not match/);
  }, 60_000);
});

describe("event-store CLI integration — default emits no events", () => {
  it("llmwiki lint exits 0 and shows no event problem on a default (no-profile) project", async () => {
    // A default project has wiki/concepts but no profile and no events.jsonl.
    await mkdir(path.join(root, CONCEPTS_DIR), { recursive: true });
    await writeFile(
      path.join(root, CONCEPTS_DIR, "intro.md"),
      "---\ntitle: Intro\nsummary: An intro page.\n---\n\nEnough body text to pass the empty-page lint rule.\n",
    );

    const result = await runCLI(["lint"], root);

    expectCLIExit(result, 0);
    expect(result.stdout + result.stderr).not.toMatch(/event-chain-broken/);
    expect(result.stdout + result.stderr).not.toMatch(/event-store/);
  }, 60_000);
});

describe("event-store CLI integration — status surfaces the problem", () => {
  it("llmwiki next --json reports non-zero lint errors after a tampered store", async () => {
    await buildTamperedProject();

    // Run lint so the cache is written (next reads the lint cache for status).
    await runCLI(["lint"], root);

    const nextResult = await runCLI(["next", "--json"], root);
    expectCLIExit(nextResult, 0);

    const payload = JSON.parse(nextResult.stdout) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;
    const lint = summary.lint as Record<string, unknown> | null;

    // The lint cache must be present and show at least one error from event-chain-broken.
    expect(lint, "lint cache missing — lint did not write it or next did not read it").not.toBeNull();
    expect((lint!.errors as number) >= 1).toBe(true);
  }, 60_000);
});
