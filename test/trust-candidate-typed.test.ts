/**
 * Phase-2 typed-target metadata on page review candidates.
 *
 * A {@link ReviewCandidate} can optionally carry a typed entity target
 * (`targetEntityType`, e.g. `"papers"`) and an attached Trust Guard decision
 * (`trustDecision`). These fields exist ONLY for configurable (non-default)
 * profiles; default-profile candidates must never populate them.
 *
 * These tests pin four guarantees, all exercising the PRODUCTION writer
 * (`writeCandidate`) and reader (`readCandidate`) rather than hand-edited JSON:
 *  (a) a draft WITH the new fields round-trips through `writeCandidate` →
 *      `readCandidate` with both fields intact;
 *  (b) PARITY GUARD — a default draft (no typed fields) persisted via
 *      `writeCandidate` produces JSON with neither key present, proving that
 *      `undefined` optional fields never leak into the persisted bytes;
 *  (c) a candidate file with a MALFORMED `trustDecision` value is sanitized
 *      (the field dropped) on read;
 *  (d) `review list` rendering for a default candidate never surfaces the
 *      (absent) typed fields.
 */

import { describe, it, expect, vi } from "vitest";
import path from "path";
import { readFile, writeFile } from "fs/promises";
import {
  writeCandidate,
  readCandidate,
} from "../src/compiler/candidates.js";
import reviewListCommand from "../src/commands/review-list.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import type { TrustDecision } from "../src/trust/decision.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

const BODY = [
  "---",
  "title: Typed Target",
  "summary: A typed candidate.",
  "sources: []",
  "---",
  "",
  "Body.",
].join("\n");

/** Read a candidate's persisted JSON as a plain object. */
async function readCandidateJson(dir: string, id: string): Promise<Record<string, unknown>> {
  const file = path.join(dir, CANDIDATES_DIR, `${id}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}

/** Join all logged args from a console spy into a single string. */
function collectLog(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("typed-target metadata on page candidates", () => {
  it("(a) writeCandidate persists + round-trips targetEntityType + trustDecision", async () => {
    const decision: TrustDecision = "stage-for-review";
    const created = await writeCandidate(root.dir, {
      title: "Typed Target",
      slug: "typed-target",
      summary: "A typed candidate.",
      sources: [],
      body: BODY,
      targetEntityType: "papers",
      trustDecision: decision,
    });

    const loaded = await readCandidate(root.dir, created.id);
    expect(loaded?.targetEntityType).toBe("papers");
    expect(loaded?.trustDecision).toBe("stage-for-review");
  });

  it("(b) PARITY GUARD: a default draft persists JSON with neither key present", async () => {
    const created = await writeCandidate(root.dir, {
      title: "Default",
      slug: "default-candidate",
      summary: "No typed fields.",
      sources: [],
      body: BODY,
    });
    const persisted = await readCandidateJson(root.dir, created.id);
    expect("targetEntityType" in persisted).toBe(false);
    expect("trustDecision" in persisted).toBe(false);
  });

  it("(c) sanitizes a malformed trustDecision value on read (field dropped)", async () => {
    const created = await writeCandidate(root.dir, {
      title: "Malformed",
      slug: "malformed-decision",
      summary: "Bad decision value.",
      sources: [],
      body: BODY,
    });
    const file = path.join(root.dir, CANDIDATES_DIR, `${created.id}.json`);
    const onDisk = { ...(await readCandidateJson(root.dir, created.id)), trustDecision: "bogus" };
    await writeFile(file, JSON.stringify(onDisk));

    const loaded = await readCandidate(root.dir, created.id);
    expect(loaded?.trustDecision).toBeUndefined();
  });

  it("(d) review list rendering is unchanged for a default candidate", async () => {
    await writeCandidate(root.dir, {
      title: "Default",
      slug: "default-candidate",
      summary: "No typed fields.",
      sources: ["a.md"],
      body: BODY,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await reviewListCommand();
    const rendered = collectLog(spy);
    spy.mockRestore();

    expect(rendered).not.toContain("targetEntityType");
    expect(rendered).not.toContain("trustDecision");
    expect(rendered).toContain("default-candidate");
  });
});
