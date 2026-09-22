/**
 * @file test/connectors/final7-effect-snapshots.test.ts
 * @description Decision 15 regressions require event, SDK-result, and terminal
 * effects to consume closed candidate-ID snapshots instead of live arrays.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { appendConnectorEvent, connectorEvent } from "../../src/connectors/audit.js";
import { renderCandidateIds } from "../../src/connectors/candidate-display.js";
import { readEvents } from "../../src/events/store-read.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { captureConnectorCommand } from "./connector-command-fixtures.js";

const root = useTempRoot();

/** Fixed event authority for direct effect-boundary tests. */
function auditDraft() {
  return {
    provenance: { connectorId: "fixture", connectorVersion: "1" },
    finalUrl: "https://fixture.local/story-1",
    contentHash: "a".repeat(64),
    draftContentHash: "b".repeat(64),
    idempotencyKey: "c".repeat(64),
  };
}

describe("Final7 closed candidate effect snapshots", () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it("rejects numeric contents hidden by a caller iterator before append", async () => {
    const ids = ["../not-validated"];
    Object.defineProperty(ids, Symbol.iterator, {
      value: function* safeIterator() { yield "safe-id"; },
    });

    await expect(appendConnectorEvent(root.dir, auditDraft(), ids, [], []))
      .rejects.toMatchObject({ name: "ConnectorCandidateBoundaryError" });
    expect((await readEvents(root.dir)).events).toEqual([]);
  });

  it("rejects a transparent proxy array at the direct event boundary", () => {
    const ids = new Proxy(["safe-id"], {});

    expect(() => connectorEvent(auditDraft(), ids, [], []))
      .toThrow(expect.objectContaining({ name: "ConnectorCandidateBoundaryError" }));
  });

  it("retains frozen event IDs after the source array changes", () => {
    const ids = ["candidate-one"];
    const event = connectorEvent(auditDraft(), ids, [], []);
    ids[0] = "candidate-two";
    const captured = event.payload.stagedCandidateIds as string[];

    expect(captured).toEqual(["candidate-one"]);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("ignores caller collection methods and renders one physical line", async () => {
    const ids = ["safe-id"];
    ids.map = (() => ["forged\nline"]) as typeof ids.map;

    const lines = await captureConnectorCommand(root.dir, { kind: "staged", candidateIds: ids });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("safe-id");
    expect(lines[0]).not.toContain("\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses an accessor result kind through the fixed command boundary", async () => {
    const result = Object.defineProperty({ candidateIds: ["safe-id"] }, "kind", {
      enumerable: true,
      get: () => "staged",
    });

    const lines = await captureConnectorCommand(root.dir, result);

    expect(lines.join("\n")).toContain("connector returned invalid candidate identities");
    expect(process.exitCode).toBe(1);
  });

  it("refuses sparse candidate results without treating holes as absence", async () => {
    const candidateIds = Array(1) as string[];
    const lines = await captureConnectorCommand(root.dir, { kind: "staged", candidateIds });

    expect(lines.join("\n")).toContain("connector returned invalid candidate identities");
    expect(process.exitCode).toBe(1);
  });

  it("refuses unknown result fields at the closed SDK boundary", async () => {
    const lines = await captureConnectorCommand(root.dir, {
      kind: "staged", candidateIds: ["safe-id"], extra: "not-authority",
    });

    expect(lines.join("\n")).toContain("connector returned invalid candidate identities");
    expect(process.exitCode).toBe(1);
  });

  it("encodes supplementary characters as two lower-case UTF-16 escapes", () => {
    const rendered = renderCandidateIds(["candidate-😀"]);

    expect(rendered).toContain("\\ud83d\\ude00");
    expect(rendered).not.toContain("😀");
    expect(Buffer.from(rendered, "ascii").toString("ascii")).toBe(rendered);
  });
});
