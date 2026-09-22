/** @file Closed record-intent admission. Requests carry exact bytes and
 * attribution, never operation authority, paths, clocks or reserved identities. */
import { describe, expect, it } from "vitest";
import { captureRecordIntent, recordIntentDigest } from "../../src/operation-bundles/record-intent.js";

const digest = `sha256:${"a".repeat(64)}`;
function intent() {
  return { schema: "llmwiki-record-intent-v1", workspaceId: "demo", effectId: "story-1",
    profileDigest: digest, target: { entityType: "stories", slug: "story-1" },
    precondition: { kind: "absent" }, proposedBody: "---\ntitle: Story\n---\nBody\n",
    origin: { provider: "llmflow", runId: "run-1", occurrenceId: "work-1", proposalDigest: digest } };
}

describe("record-intent boundary", () => {
  it("captures exact bytes and nested values before caller mutation", () => {
    const input = intent(), captured = captureRecordIntent(input), before = recordIntentDigest(captured);
    input.target.slug = "changed"; input.proposedBody += "changed";
    expect(captured.target.slug).toBe("story-1");
    expect(recordIntentDigest(captured)).toBe(before);
    expect(recordIntentDigest(captureRecordIntent({ ...intent(), proposedBody: "different" }))).not.toBe(before);
  });
  it("refuses authority, reserved identity, paths and unknown fields", () => {
    for (const key of ["principal", "grants", "clock", "runtime", "bundleId", "path"]) {
      expect(() => captureRecordIntent({ ...intent(), [key]: "injected" })).toThrow();
    }
    expect(() => captureRecordIntent({ ...intent(), target: { entityType: "stories", slug: "../escape" } })).toThrow();
    expect(() => captureRecordIntent({ ...intent(), precondition: { kind: "absent", digest } })).toThrow();
  });
  it("never evaluates accessors or accepts inherited request data", () => {
    let calls = 0;
    const input = intent(); Object.defineProperty(input, "proposedBody", { get() { calls++; return "injected"; } });
    expect(() => captureRecordIntent(input)).toThrow(); expect(calls).toBe(0);
    expect(() => captureRecordIntent(Object.create(intent()))).toThrow();
  });
  it("requires canonical digests and lossless bounded UTF-8", () => {
    expect(() => captureRecordIntent({ ...intent(), profileDigest: "a".repeat(64) })).toThrow();
    expect(() => captureRecordIntent({ ...intent(), proposedBody: "\ud800" })).toThrow();
    expect(() => captureRecordIntent({ ...intent(), proposedBody: "x".repeat(1024 * 1024 + 1) })).toThrow();
    expect(captureRecordIntent({ ...intent(), precondition: { kind: "digest", digest } }).precondition.kind).toBe("digest");
  });
});
