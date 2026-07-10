/**
 * @file test/lifecycle-audit-payload.test.ts
 * @description Security-invariant tests for the lifecycle audit event: a
 * transition must NEVER leave the page lifecycle field changed WITHOUT a matching
 * `lifecycle-transition` audit event. The pre-fix handler recorded the RAW caller
 * `evidenceKeys` (not the allow-listed accepted keys) and emitted the event AFTER
 * committing the page, so a caller could pad `evidence` with junk keys until the
 * event record exceeded {@link MAX_EVENT_RECORD_BYTES} — the page committed, then
 * the event append threw, leaving an UNAUDITED, caller-controlled mutation.
 *
 * These tests pin two fixes: (1) the event records ONLY the accepted/declared
 * evidence keys, and (2) the event record size is pre-flighted BEFORE the page
 * write so an over-cap event fails the transition CLOSED with the page unchanged.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { preflightEventAppend } from "../src/events/store.js";
import { readEvents } from "../src/events/store-read.js";
import {
  buildPapersLifecycleProject,
  pageLifecycle,
  reviewerLifecycleProfile,
} from "./fixtures/seam-fixtures.js";
import { MAX_EVENT_RECORD_BYTES } from "../src/utils/constants.js";

/** Build a project with `papers/a` in `draft` under the reviewer-gated lifecycle. */
async function makeReviewerRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lc-audit-"));
  await buildPapersLifecycleProject(root, reviewerLifecycleProfile());
  return root;
}

/** Build an evidence object: a valid `reviewer` key plus `count` junk keys. */
function evidenceWithJunk(count: number): Record<string, unknown> {
  const evidence: Record<string, unknown> = { reviewer: "alice" };
  for (let i = 0; i < count; i++) evidence[`junk_padding_key_number_${i}`] = 1;
  return evidence;
}

describe("lifecycle audit-event payload is bounded to accepted evidence", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  // INVARIANT (teeth): with enough junk evidence keys that the RAW-keys event
  // would exceed MAX_EVENT_RECORD_BYTES, it must NEVER be the case that the page
  // lifecycle changed WITHOUT a matching audit event. Pre-fix: page committed
  // (junk dropped) then the raw-keys event threw → page-changed-without-audit.
  it("transition with valid evidence + over-cap junk keys keeps page+audit in lockstep", async () => {
    root = await makeReviewerRoot();
    // ~12k keys × ~28 bytes/key in the JSON array ≫ 100KB cap on the raw payload.
    const junkCount = Math.ceil(MAX_EVENT_RECORD_BYTES / 25) + 2000;
    await transitionLifecycle(root, "papers", "a", "review", evidenceWithJunk(junkCount));
    const events = (await readEvents(root)).events;
    const transition = events.find((e) => e.type === "lifecycle-transition");
    // The page changed — so a matching audit event MUST exist (the invariant).
    expect(await pageLifecycle(root, "a")).toBe("review");
    expect(transition).toBeTruthy();
    // And it records ONLY the declared key that satisfied the gate — no junk inflated it.
    expect(transition?.payload.evidenceKeys).toEqual(["reviewer"]);
  });

  // `evidenceKeys` records the declared requirement keys that SATISFIED the gate,
  // not just what the caller re-supplied. A required field already present on the
  // page (caller passes NO evidence) must still be recorded — not a misleading [].
  it("records a requirement satisfied by EXISTING frontmatter even with no caller evidence", async () => {
    root = await makeReviewerRoot();
    // Seed the reviewer on the page itself, then transition with NO caller evidence.
    await writeFile(
      path.join(root, "wiki/papers/a.md"),
      "---\nlifecycle: draft\nreviewer: bob\n---\n\nBody.\n",
      "utf8",
    );
    await transitionLifecycle(root, "papers", "a", "review");
    const transition = (await readEvents(root)).events.find((e) => e.type === "lifecycle-transition");
    expect(await pageLifecycle(root, "a")).toBe("review");
    expect(transition?.payload.evidenceKeys).toEqual(["reviewer"]);
  });
});

describe("preflightEventAppend gates the page write on the event record size", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  /** A minimal event content whose payload carries `bytes` worth of filler. */
  function eventOfSize(bytes: number) {
    return {
      type: "lifecycle-transition" as const,
      origin: "sdk",
      payload: { filler: "x".repeat(bytes) },
      at: new Date().toISOString(),
    };
  }

  it("throws on an over-cap event content (would brick the append)", async () => {
    root = await makeReviewerRoot();
    await expect(preflightEventAppend(root, eventOfSize(MAX_EVENT_RECORD_BYTES + 1000))).rejects.toThrow();
  });

  it("passes for an in-cap event content", async () => {
    root = await makeReviewerRoot();
    await expect(preflightEventAppend(root, eventOfSize(100))).resolves.toBeUndefined();
  });
});
