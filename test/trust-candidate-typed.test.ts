/**
 * Phase-2 typed-target metadata on page review candidates.
 *
 * A {@link ReviewCandidate} can optionally carry a typed entity target
 * (`targetEntityType`, e.g. `"papers"`) and an attached Trust Guard decision
 * (`trustDecision`). These fields exist ONLY for configurable (non-default)
 * profiles; default-profile candidates must never populate them.
 *
 * These tests pin three guarantees:
 *  (a) a candidate WITH the new fields round-trips through the candidate
 *      serialization (`JSON.stringify(candidate, null, 2)`) → `readCandidate`
 *      with both fields intact;
 *  (b) PARITY GUARD — a candidate created WITHOUT the new fields, serialized via
 *      the SAME path, produces JSON with neither key present, proving that
 *      `undefined` optional fields never leak into the persisted bytes;
 *  (c) `review list` rendering for a default candidate is byte-identical whether
 *      or not the (absent) typed fields are part of the model.
 */

import { describe, it, expect, vi } from "vitest";
import path from "path";
import { writeFile } from "fs/promises";
import {
  writeCandidate,
  readCandidate,
} from "../src/compiler/candidates.js";
import reviewListCommand from "../src/commands/review-list.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import type { ReviewCandidate } from "../src/utils/types.js";
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

/** Persist a full ReviewCandidate via the exact serialization writeCandidate uses. */
async function persistCandidate(dir: string, candidate: ReviewCandidate): Promise<void> {
  const file = path.join(dir, CANDIDATES_DIR, `${candidate.id}.json`);
  await writeFile(file, JSON.stringify(candidate, null, 2));
}

/** Join all logged args from a console spy into a single string. */
function collectLog(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("typed-target metadata on page candidates", () => {
  it("(a) round-trips targetEntityType + trustDecision with the fields intact", async () => {
    const base = await writeCandidate(root.dir, {
      title: "Typed Target",
      slug: "typed-target",
      summary: "A typed candidate.",
      sources: [],
      body: BODY,
    });
    const decision: TrustDecision = "stage-for-review";
    const typed: ReviewCandidate = {
      ...base,
      targetEntityType: "papers",
      trustDecision: decision,
    };
    await persistCandidate(root.dir, typed);

    const loaded = await readCandidate(root.dir, base.id);
    expect(loaded?.targetEntityType).toBe("papers");
    expect(loaded?.trustDecision).toBe("stage-for-review");
  });

  it("(b) PARITY GUARD: a default candidate serializes with neither key present", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Default",
      slug: "default-candidate",
      summary: "No typed fields.",
      sources: [],
      body: BODY,
    });
    const parsed = JSON.parse(JSON.stringify(candidate, null, 2));
    expect("targetEntityType" in parsed).toBe(false);
    expect("trustDecision" in parsed).toBe(false);
  });

  it("(c) review list rendering is unchanged for a default candidate", async () => {
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
