/**
 * @file test/scale/downgrade-cancel-capture.test.ts
 * @description Pure witnesses of the EXACT-CAPTURE comparison
 * (`isSameCapture`, Root review of checkpoint 15) that the cancel uses right
 * before the record step and before a receipt attests a cancel: a re-read
 * cancel intent counts only when it is the captured one in full. A
 * same-plan, same-outcome replacement whose prior identities differ is NOT
 * the capture that was proven, nor is one declaring another record outcome.
 * No file system.
 */

import { describe, expect, it } from "bun:test";
import { isSameCapture } from "../../src/scale/downgrade-cancel-bind.js";
import type { CancelIntentV1 } from "../../src/scale/downgrade-journal.js";

const RECORD_SHA = "c".repeat(64);
const CAPTURED: CancelIntentV1 = {
  format: "llmwiki-scale-downgrade-cancel", version: 1, plan: "a".repeat(64), phase: "fenced", fenceRevision: 3, cancelRevision: 4, recordSha256: RECORD_SHA,
  priors: [
    { relPath: "wiki/graph/events.jsonl", sha256: "e".repeat(64), identity: { kind: "file", dev: "1", ino: "2", size: "5", mtimeNs: "6" } },
    { relPath: ".llmwiki/embeddings.json", sha256: null, identity: null },
  ],
};

/** A deep copy of the capture, as a re-read leaf would be, with `edit` applied. */
function reread(edit: (copy: CancelIntentV1) => CancelIntentV1 = (copy) => copy): CancelIntentV1 {
  return edit(JSON.parse(JSON.stringify(CAPTURED)) as CancelIntentV1);
}

describe("the exact-capture comparison", () => {
  it("accepts the captured cancel intent re-read unchanged", () => {
    expect(isSameCapture(CAPTURED, reread(), RECORD_SHA)).toBe(true);
  });

  it("rejects a same-plan, same-outcome intent whose prior identity differs", () => {
    const altered = reread((copy) => ({ ...copy, priors: copy.priors.map((prior, at) => (at === 0 ? { ...prior, identity: { ...prior.identity!, ino: "999" } } : prior)) }));
    expect([altered.plan, altered.recordSha256]).toEqual([CAPTURED.plan, CAPTURED.recordSha256]);
    expect(isSameCapture(CAPTURED, altered, RECORD_SHA)).toBe(false);
  });

  it("rejects an intent declaring another record outcome, and a missing intent", () => {
    expect(isSameCapture(CAPTURED, reread(), "d".repeat(64))).toBe(false);
    expect(isSameCapture(CAPTURED, reread((copy) => ({ ...copy, recordSha256: "d".repeat(64) })), "d".repeat(64))).toBe(false);
    expect(isSameCapture(CAPTURED, null, RECORD_SHA)).toBe(false);
  });
});
