/**
 * @file test/portable/originals-client-outcomes.test.ts
 * @description Focused PURE regression tests of what the `portable-originals/2`
 * client accepts as a host's answer (the CP181 false-success fix): control and
 * stage answers must be the method's own established answer or a closed
 * refusal, and a staged add must be a publication arm bound to the held
 * operation id — publishing `sourcePath(name)` when committed — or it is
 * `unknown` under that id after exactly one attempt.
 *
 * A committed staged add publishes the bounded DERIVATIVE of the original, so
 * a valid commit may name a digest different from the request's original
 * digest; that case must pass.
 *
 * STATUS: UNRUN when written (CP181). These are pure contract tests over the
 * validator and its one-attempt callback seam: no fetch, spy, listener,
 * socket, host, model or subprocess. They are not live-host or packaged
 * runtime proof.
 */

import { describe, expect, it } from "bun:test";
import { sourcePath } from "../../src/portable/logical-paths.js";
import {
  establishedAnswer, isNegotiation, isOriginalStatOf, isStageStep, settleStagedAdd, type StageExpectation,
} from "../../src/portable/originals/client-outcomes.js";

const HELD = "op-held";
const NAME = "paper.pdf";
const ORIGINAL = `sha256:${"a".repeat(64)}` as const;
const DERIVATIVE = `sha256:${"b".repeat(64)}`;
const NOTICE = "Results reflect your access";
const REQUEST = { operationId: HELD, name: NAME, handle: "h-1", digest: ORIGINAL };
const UNKNOWN = { kind: "unknown", operationId: HELD };

/** A complete committed staged add: the derivative at the source path, and its reference record. */
function committed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const published = [
    { path: sourcePath(NAME), digest: DERIVATIVE, labels: [] },
    { path: `references/${NAME}`, digest: ORIGINAL, labels: [] },
  ];
  return { kind: "committed", operationId: HELD, head: 3, skipped: [], published, ...overrides };
}

/** Settle `answer` as the one reply of a staged add, counting the attempts made. */
async function settled(answer: unknown): Promise<{ outcome: unknown; attempts: number }> {
  let attempts = 0;
  const outcome = await settleStagedAdd(REQUEST, async () => { attempts += 1; return answer; });
  return { outcome, attempts };
}

/** The outcome alone of settling `answer`. */
async function outcomeOf(answer: unknown): Promise<unknown> {
  return (await settled(answer)).outcome;
}

describe("staged add: a committed answer", () => {
  it("accepts a committed source whose derivative digest differs from the original's", async () => {
    expect(await settled(committed())).toEqual({ outcome: committed(), attempts: 1 });
  });

  it("is unknown when the committed arm names another operation or none", async () => {
    expect(await outcomeOf(committed({ operationId: "op-other" }))).toEqual(UNKNOWN);
    expect(await outcomeOf(committed({ operationId: undefined }))).toEqual(UNKNOWN);
  });

  it("is unknown when the committed payload is incomplete", async () => {
    expect(await outcomeOf(committed({ published: [] }))).toEqual(UNKNOWN);
    expect(await outcomeOf(committed({ head: "3" }))).toEqual(UNKNOWN);
    expect(await outcomeOf(committed({ skipped: undefined }))).toEqual(UNKNOWN);
    expect(await outcomeOf(committed({ published: [{ path: sourcePath(NAME), labels: [] }] }))).toEqual(UNKNOWN);
  });

  it("is unknown when nothing was published at the requested source path", async () => {
    const elsewhere = [{ path: sourcePath("other.pdf"), digest: DERIVATIVE, labels: [] }, { path: `references/${NAME}`, digest: ORIGINAL, labels: [] }];
    expect(await outcomeOf(committed({ published: elsewhere }))).toEqual(UNKNOWN);
  });
});

describe("staged add: refusals and non-commit arms", () => {
  it("keeps this protocol's closed refusals", async () => {
    for (const code of ["handle_unavailable", "not_text", "permission_denied"]) {
      const refusal = { kind: "refused", code, notice: NOTICE };
      expect(await outcomeOf(refusal)).toEqual(refusal);
    }
  });

  it("is unknown for a refusal code outside the closed sets", async () => {
    expect(await outcomeOf({ kind: "refused", code: "upstream_timeout", notice: NOTICE })).toEqual(UNKNOWN);
    expect(await outcomeOf({ kind: "refused", operationId: HELD, code: "handle_unavailable" })).toEqual(UNKNOWN);
  });

  it("keeps the shared non-commit arms of the held operation", async () => {
    const arms = [
      { kind: "in_progress", operationId: HELD },
      { kind: "refused", operationId: HELD, code: "operation_unsupported_on_portable_path" },
      { kind: "rejected", reason: "operation_id_in_use" },
    ];
    for (const arm of arms) expect(await outcomeOf(arm)).toEqual(arm);
  });

  it("is unknown for a shared arm of another operation", async () => {
    expect(await outcomeOf({ kind: "refused", operationId: "op-other", code: "permission_denied" })).toEqual(UNKNOWN);
    expect(await outcomeOf({ kind: "in_progress", operationId: "op-other" })).toEqual(UNKNOWN);
  });
});

describe("staged add: malformed and failed answers", () => {
  it("is unknown for a kind-less error body or the wrong kind", async () => {
    const bodies = [{ error: "upstream timeout" }, { kind: "error" }, { kind: "staged", handle: "h-1" }, { kind: "proposed", operationId: HELD }];
    for (const body of bodies) expect(await outcomeOf(body)).toEqual(UNKNOWN);
  });

  it("is unknown for null, a primitive or an array", async () => {
    for (const body of [null, "committed", 7, [committed()]]) expect(await outcomeOf(body)).toEqual(UNKNOWN);
  });

  it("maps a transport failure to unknown after exactly one attempt", async () => {
    let attempts = 0;
    const outcome = await settleStagedAdd(REQUEST, async () => { attempts += 1; throw new TypeError("fetch failed"); });
    expect({ outcome, attempts }).toEqual({ outcome: UNKNOWN, attempts: 1 });
  });

  it("maps an unreadable body to unknown after exactly one attempt", async () => {
    let attempts = 0;
    const outcome = await settleStagedAdd(REQUEST, async () => { attempts += 1; throw new SyntaxError("Unexpected token <"); });
    expect({ outcome, attempts }).toEqual({ outcome: UNKNOWN, attempts: 1 });
  });
});

describe("control answers: negotiation and refusals", () => {
  const negotiate = (answer: unknown): unknown => establishedAnswer("negotiate", answer, isNegotiation);

  it("accepts a negotiation of this protocol", () => {
    const answer = { kind: "negotiated", protocol: "portable-originals/2", capabilities: { stagedWrites: "host-file-cas" } };
    expect(negotiate(answer)).toEqual(answer);
  });

  it("throws for another protocol or missing capabilities", () => {
    expect(() => negotiate({ kind: "negotiated", protocol: "portable-originals/1", capabilities: {} })).toThrow("negotiate");
    expect(() => negotiate({ kind: "negotiated", protocol: "portable-originals/2" })).toThrow("negotiate");
  });

  it("passes a closed refusal through", () => {
    const refusal = { kind: "refused", code: "capability_unsupported", capability: "stagedWrites", notice: NOTICE };
    expect(negotiate(refusal)).toEqual(refusal);
  });

  it("throws for an unknown code, a misplaced capability or an operation id", () => {
    expect(() => negotiate({ kind: "refused", code: "teapot", notice: NOTICE })).toThrow("negotiate");
    expect(() => negotiate({ kind: "refused", code: "permission_denied", capability: "stagedWrites", notice: NOTICE })).toThrow("negotiate");
    expect(() => negotiate({ kind: "refused", code: "permission_denied", operationId: HELD, notice: NOTICE })).toThrow("negotiate");
  });

  it("throws for kind-less, wrong-kind, null and array bodies", () => {
    for (const body of [{ error: "bad gateway" }, { kind: "original" }, null, [], "negotiated"]) {
      expect(() => negotiate(body)).toThrow("the host did not establish a negotiate outcome");
    }
  });
});

describe("control answers: original metadata", () => {
  const stat = (answer: unknown): unknown => establishedAnswer("originals.stat", answer, isOriginalStatOf(NAME));
  const original = { kind: "original", name: NAME, digest: ORIGINAL, byteCount: 12, labels: ["team"], derivative: { digest: DERIVATIVE } };

  it("accepts the metadata of the named original", () => {
    expect(stat(original)).toEqual(original);
  });

  it("throws for another original's metadata", () => {
    expect(() => stat({ ...original, name: "other.pdf" })).toThrow("originals.stat");
  });

  it("throws for missing or malformed identity fields", () => {
    expect(() => stat({ ...original, digest: undefined })).toThrow("originals.stat");
    expect(() => stat({ ...original, byteCount: 1.5 })).toThrow("originals.stat");
    expect(() => stat({ ...original, derivative: {} })).toThrow("originals.stat");
  });
});

/** A staged view of handle `h-1` at 10 declared bytes, with `overrides`. */
function staged(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "staged", handle: "h-1", state: "open", declaredBytes: 10, receivedBytes: 0, expiresAt: "2026-11-14T23:30:00.000Z", ...overrides };
}

/** Establish `answer` as one stage step under `expected`. */
function stageStep(expected: StageExpectation, answer: unknown): unknown {
  return establishedAnswer("stage", answer, isStageStep(expected));
}

describe("stage answers", () => {
  const held = { declaredBytes: 10, handle: "h-1" };

  it("accepts an opened, an appended and a sealed view of the held handle", () => {
    expect(stageStep({ step: "opened", declaredBytes: 10 }, staged())).toEqual(staged());
    expect(stageStep({ ...held, step: "appended" }, staged({ receivedBytes: 10 }))).toEqual(staged({ receivedBytes: 10 }));
    const sealed = staged({ state: "sealed", receivedBytes: 10, digest: ORIGINAL });
    expect(stageStep({ ...held, step: "sealed" }, sealed)).toEqual(sealed);
  });

  it("throws for an opened view that is not empty or not the declared size", () => {
    expect(() => stageStep({ step: "opened", declaredBytes: 10 }, staged({ receivedBytes: 4 }))).toThrow("stage");
    expect(() => stageStep({ step: "opened", declaredBytes: 10 }, staged({ declaredBytes: 11 }))).toThrow("stage");
  });

  it("throws for another handle or more bytes than declared", () => {
    expect(() => stageStep({ ...held, step: "appended" }, staged({ handle: "h-2" }))).toThrow("stage");
    expect(() => stageStep({ ...held, step: "appended" }, staged({ receivedBytes: 11 }))).toThrow("stage");
  });

  it("throws for a seal that is still open, short of the declared size or without a digest", () => {
    expect(() => stageStep({ ...held, step: "sealed" }, staged({ receivedBytes: 10, digest: ORIGINAL }))).toThrow("stage");
    expect(() => stageStep({ ...held, step: "sealed" }, staged({ state: "sealed", receivedBytes: 9, digest: ORIGINAL }))).toThrow("stage");
    expect(() => stageStep({ ...held, step: "sealed" }, staged({ state: "sealed", receivedBytes: 10 }))).toThrow("stage");
  });

  it("throws for a kind-less error body and passes a closed refusal through", () => {
    expect(() => stageStep({ ...held, step: "appended" }, { kind: "error" })).toThrow("stage");
    const refusal = { kind: "refused", code: "quota_exceeded", notice: NOTICE };
    expect(stageStep({ step: "opened", declaredBytes: 10 }, refusal)).toEqual(refusal);
  });
});
