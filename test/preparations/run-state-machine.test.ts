/**
 * @file test/preparations/run-state-machine.test.ts
 * @description Legal-edge, genesis, and terminal-rule contract for the run
 * loader: a valid progression parses, an illegal direct edge is rejected, a
 * terminal success with a required-phase deficit or an outcome-unknown effect is
 * rejected, and handoff/supersession coupling is enforced exactly.
 */

import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/capability-providers/ids.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { signPreparationRun } from "../../src/preparations/run-integrity.js";
import { parsePreparationRun } from "../../src/preparations/run-parse.js";
import { deriveBrokerRequestId } from "../../src/preparations/ids.js";
import { LEGAL_EDGES, UNRESOLVED_EFFECT_FORBIDDEN } from "../../src/preparations/run-validation.js";
import type { PreparationRunState } from "../../src/preparations/run-types.js";
import { append, genesisContent, signedRunText, testKey } from "./run-fixture.js";

const ACTOR = { id: "operator", surface: "cli" } as const;
const PAT = `pat_${"a".repeat(64)}` as const;
const BRQ = deriveBrokerRequestId(PAT, 0);

/** Serialize a signed run content through the test key. */
function text(content: Parameters<typeof signPreparationRun>[1]): string {
  return canonicalBytes(signPreparationRun(testKey(), content)).toString("utf8");
}

/** Build a running run advanced into one terminal state for the effect-safety tests. */
function terminal(state: "succeeded" | "failed") {
  const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
  return append(running, { type: state, stateAfter: state, actor: ACTOR, at: "2026-07-20T00:00:02.000Z", payload: { kind: "none" } });
}

describe("preparation run state machine", () => {
  it("accepts a legal planned -> running -> failed progression", () => {
    const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const failed = append(running, { type: "failed", stateAfter: "failed", actor: ACTOR, at: "2026-07-20T00:00:02.000Z", payload: { kind: "none" } });
    expect(parsePreparationRun(signedRunText(failed)).state).toBe("failed");
  });

  it("rejects an illegal direct planned -> cancelled edge", () => {
    const illegal = append(genesisContent(), { type: "cancelled", stateAfter: "cancelled", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "none" } });
    expect(() => parsePreparationRun(signedRunText(illegal))).toThrow(/illegal preparation run state edge/);
  });

  it("rejects a transition type that does not produce its recorded state", () => {
    const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const bent = { ...running, transitions: [running.transitions[0], { ...running.transitions[1]!, stateAfter: "paused" as const }] };
    expect(() => parsePreparationRun(text(bent))).toThrow();
  });

  it("rejects a terminal success carrying an outcome-unknown effect", () => {
    const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const succeeded = append(running, { type: "succeeded", stateAfter: "succeeded", actor: ACTOR, at: "2026-07-20T00:00:02.000Z", payload: { kind: "none" } });
    const withEffect = { ...succeeded, effectSummaries: [{ attemptId: `pat_${"a".repeat(64)}` as const, effectIndex: 0, outcome: "outcome-unknown" as const }] };
    expect(() => parsePreparationRun(text(withEffect))).toThrow(/outcome-unknown/);
  });

  it("rejects a settlement state carrying a durably-started but unreceipted effect", () => {
    const started = { ...terminal("succeeded"), effectSummaries: [{ attemptId: PAT, effectIndex: 0, outcome: "started" as const }] };
    expect(() => parsePreparationRun(text(started))).toThrow(/unresolved "started" external effect/);
  });

  it("rejects a failed state that would silently lose a started external effect", () => {
    const started = { ...terminal("failed"), effectSummaries: [{ attemptId: PAT, effectIndex: 0, outcome: "started" as const }] };
    expect(() => parsePreparationRun(text(started))).toThrow(/unresolved "started" external effect/);
  });

  it("rejects a settlement state carrying a pending broker request", () => {
    const pending = { ...terminal("succeeded"), brokerRequestSummaries: [{ brokerRequestId: BRQ, attemptId: PAT, requestIndex: 0, state: "started" as const }] };
    expect(() => parsePreparationRun(text(pending))).toThrow(/pending broker request/);
  });

  it("accepts a settlement state whose external effect is fully settled", () => {
    const settled = { ...terminal("succeeded"), effectSummaries: [{ attemptId: PAT, effectIndex: 0, outcome: "applied" as const, receiptDigest: parseSha256Digest(`sha256:${"b".repeat(64)}`) }], brokerRequestSummaries: [{ brokerRequestId: BRQ, attemptId: PAT, requestIndex: 0, state: "settled" as const }] };
    expect(parsePreparationRun(text(settled)).state).toBe("succeeded");
  });

  it("forbids an unresolved effect in every terminal state except abandoned, plus handoff-ready (PO-INV-30)", () => {
    // The rule above is state-agnostic, so succeeded/failed prove the MECHANISM;
    // what is left unproven is the SET. Cross-check the hand-written forbidden
    // list against the edge-derived terminal states so a member drifting out —
    // superseded / handoff-ready / handed-off / succeeded-with-warnings silently
    // admitting an unsettled effect — reddens here instead of passing the suite.
    const terminal = (Object.keys(LEGAL_EDGES) as PreparationRunState[]).filter((state) => LEGAL_EDGES[state].size === 0);
    const expected = new Set<PreparationRunState>([...terminal.filter((state) => state !== "abandoned"), "handoff-ready"]);
    expect(new Set(UNRESOLVED_EFFECT_FORBIDDEN)).toEqual(expected);
  });

  it("rejects a handed-off state with no handoff binding", () => {
    const ready = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const handedOff = { ...ready, state: "handed-off" as const };
    expect(() => parsePreparationRun(text(handedOff))).toThrow();
  });

  it("accepts a post-terminal notice on a succeeded run (design 23.2)", () => {
    const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const succeeded = append(running, { type: "succeeded", stateAfter: "succeeded", actor: ACTOR, at: "2026-07-20T00:00:02.000Z", payload: { kind: "none" } });
    const noted = append(succeeded, { type: "notice-recorded", stateAfter: "succeeded", actor: ACTOR, at: "2026-07-20T00:00:03.000Z", payload: { kind: "notice", code: "cancellation-arrived-after-completion" } });
    const parsed = parsePreparationRun(signedRunText(noted));
    expect(parsed.state).toBe("succeeded");
    expect(parsed.notices).toEqual([{ code: "cancellation-arrived-after-completion" }]);
  });

  it("rejects an execution owner whose pid no signal probe can answer about", () => {
    // THE SAME BOUND THE LOCK LEAF TAKES, applied where a DURABLE record enters.
    // `count` admits any nonnegative safe integer, so this record could carry a
    // pid far above what `process.kill` accepts as an argument — and that throws
    // a TypeError with no errno, which the liveness probe reads as a dead
    // process. For an execution owner that is the destructive direction: a
    // possibly-live executor parked and its fence cleared. Refusing to LOAD such
    // a record is what makes the probe's unknown-code arm unreachable rather
    // than merely argued about.
    const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const owner = { pid: 1, processStartTime: "Thu Jul 23 11:16:28 2026", leaseNonce: "n", attemptId: PAT, acquiredAt: "2026-07-20T00:00:01.000Z" };
    // PIN THE PRECONDITION: the same record with an in-range pid loads fine, so
    // the rejection below is about the bound and nothing else.
    expect(parsePreparationRun(text({ ...running, executionOwner: owner })).executionOwner?.pid).toBe(1);
    for (const pid of [0, 1.5, 2147483648, Number.MAX_SAFE_INTEGER]) {
      expect(() => parsePreparationRun(text({ ...running, executionOwner: { ...owner, pid } })))
        .toThrow(/executionOwner pid/u);
    }
  });

  it("rejects a completion warning after ABANDONED, the terminal only the derivation supplies", () => {
    // THE COVERAGE GAP THE DERIVATION EXPOSED. Terminality now comes from
    // `LEGAL_EDGES` instead of a hand-written set beside it, and dropping
    // `abandoned` from that derivation left the ENTIRE suite green — the
    // post-terminal warning rule was only ever exercised through `succeeded`.
    // A derived set is not self-proving: it still needs a case per member that
    // nothing else reaches.
    const parked = append(genesisContent(), { type: "recovery-required", stateAfter: "recovery-required", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "problem", code: "preparation-integrity-obligation" } });
    const abandoned = append(parked, { type: "abandoned", stateAfter: "abandoned", actor: ACTOR, at: "2026-07-20T00:00:02.000Z", payload: { kind: "abandonment", confirmation: "confirm-residual-state", findingCount: 0 }, residualFindings: [] });
    // PIN THE PRECONDITION: the run really did reach the terminal, so the
    // rejection below is about the warning rather than about a bad setup.
    expect(parsePreparationRun(signedRunText(abandoned)).state).toBe("abandoned");

    const warned = append(abandoned, { type: "warning-recorded", stateAfter: "abandoned", actor: ACTOR, at: "2026-07-20T00:00:03.000Z", payload: { kind: "warning", code: "late", attempted: 1, completed: 0, skipped: 0, failed: 1 } });
    expect(() => parsePreparationRun(signedRunText(warned)))
      .toThrow(/completion warning cannot be recorded after a terminal state/u);
  });

  it("rejects a completion warning recorded after a terminal state", () => {
    const running = append(genesisContent(), { type: "phase-started", stateAfter: "running", actor: ACTOR, at: "2026-07-20T00:00:01.000Z", payload: { kind: "phase", phaseInstanceId: `phi_${"a".repeat(64)}`, phaseState: "running" } });
    const failed = append(running, { type: "failed", stateAfter: "failed", actor: ACTOR, at: "2026-07-20T00:00:02.000Z", payload: { kind: "none" } });
    const warned = append(failed, { type: "warning-recorded", stateAfter: "failed", actor: ACTOR, at: "2026-07-20T00:00:03.000Z", payload: { kind: "warning", code: "late", attempted: 1, completed: 0, skipped: 0, failed: 1 } });
    expect(() => parsePreparationRun(text(warned))).toThrow(/after a terminal state/);
  });
});
