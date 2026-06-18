/**
 * Unit coverage for the Trust Guard decision core
 * (`src/trust/decision.ts`). These tests pin the two structural contracts of
 * `composeTrustDecision` — totality and monotonicity in `block` — plus the
 * concrete routing/quarantine/warn-floor rules from the CLP Trust Guard spec.
 *
 * Totality is proven by EXHAUSTIVE NESTED ENUMERATION (fast-check is not a
 * project dependency): every verdict multiset of size 0..3 over
 * {pass,warn,block}, crossed with `reviewRouted` ∈ {true,false}, is fed to the
 * composer and asserted to return one of the five defined decisions without
 * throwing or returning undefined. The same enumeration backs the
 * monotone-in-block and warn-floor properties.
 */

import { describe, it, expect } from "vitest";
import {
  composeTrustDecision,
  type TrustVerdict,
  type TrustDecision,
  type TrustCheckResult,
} from "../src/trust/decision.js";

const VERDICTS: TrustVerdict[] = ["pass", "warn", "block"];
const DECISIONS: TrustDecision[] = [
  "allow",
  "allow-with-warning",
  "stage-for-review",
  "quarantine",
  "deny",
];
const ROUTINGS = [true, false];

/** A check result carrying only a verdict (no quarantine flag). */
function check(verdict: TrustVerdict): TrustCheckResult {
  return { code: verdict, verdict, message: verdict };
}

/** Every verdict multiset of length 0..maxSize over {pass,warn,block}. */
function enumerateVerdictSets(maxSize: number): TrustVerdict[][] {
  let sets: TrustVerdict[][] = [[]];
  for (let size = 1; size <= maxSize; size++) {
    const grown: TrustVerdict[][] = [];
    for (const set of sets.filter((s) => s.length === size - 1)) {
      for (const v of VERDICTS) grown.push([...set, v]);
    }
    sets = sets.concat(grown);
  }
  return sets;
}

const ALL_SETS = enumerateVerdictSets(3);

describe("composeTrustDecision totality", () => {
  it("returns a defined decision (never throwing) for every verdict set × routing", () => {
    // Totality: across the full ALL_SETS × ROUTINGS product the function always
    // resolves to a DECISIONS member. A returned, defined decision also proves
    // it did not throw, so the two properties fold into this one enumeration.
    for (const set of ALL_SETS) {
      for (const reviewRouted of ROUTINGS) {
        const decision = composeTrustDecision(set.map(check), { reviewRouted });
        expect(DECISIONS).toContain(decision);
      }
    }
  });
});

describe("composeTrustDecision monotone-in-block", () => {
  it("any block ⇒ decision is strict (never allow/allow-with-warning)", () => {
    const strict = ["stage-for-review", "quarantine", "deny"];
    for (const set of ALL_SETS.filter((s) => s.includes("block"))) {
      for (const reviewRouted of ROUTINGS) {
        const decision = composeTrustDecision(set.map(check), { reviewRouted });
        expect(strict).toContain(decision);
      }
    }
  });
});

describe("composeTrustDecision warn floor", () => {
  it("≥1 warn and 0 block ⇒ allow-with-warning (never allow)", () => {
    const warnSets = ALL_SETS.filter(
      (s) => s.includes("warn") && !s.includes("block")
    );
    for (const set of warnSets) {
      for (const reviewRouted of ROUTINGS) {
        const decision = composeTrustDecision(set.map(check), { reviewRouted });
        expect(decision).toBe("allow-with-warning");
      }
    }
  });
});

describe("composeTrustDecision pass/empty", () => {
  it("empty result set ⇒ allow", () => {
    expect(composeTrustDecision([], { reviewRouted: false })).toBe("allow");
    expect(composeTrustDecision([], { reviewRouted: true })).toBe("allow");
  });

  it("all-pass ⇒ allow regardless of routing", () => {
    const allPass = ALL_SETS.filter(
      (s) => s.length > 0 && s.every((v) => v === "pass")
    );
    for (const set of allPass) {
      for (const reviewRouted of ROUTINGS) {
        expect(composeTrustDecision(set.map(check), { reviewRouted })).toBe(
          "allow"
        );
      }
    }
  });
});

describe("composeTrustDecision block routing", () => {
  it("block + reviewRouted=true ⇒ stage-for-review", () => {
    expect(
      composeTrustDecision([check("block")], { reviewRouted: true })
    ).toBe("stage-for-review");
  });

  it("block + reviewRouted=false ⇒ deny", () => {
    expect(
      composeTrustDecision([check("block")], { reviewRouted: false })
    ).toBe("deny");
  });

  it("block mixed with pass/warn still routes by the block", () => {
    const mixed = [check("pass"), check("warn"), check("block")];
    expect(composeTrustDecision(mixed, { reviewRouted: true })).toBe(
      "stage-for-review"
    );
    expect(composeTrustDecision(mixed, { reviewRouted: false })).toBe("deny");
  });
});

describe("composeTrustDecision quarantine", () => {
  it("a block with quarantine:true ⇒ quarantine regardless of routing", () => {
    const q: TrustCheckResult = {
      code: "untrusted",
      verdict: "block",
      message: "untrusted content",
      quarantine: true,
    };
    expect(composeTrustDecision([q], { reviewRouted: true })).toBe(
      "quarantine"
    );
    expect(composeTrustDecision([q], { reviewRouted: false })).toBe(
      "quarantine"
    );
  });

  it("quarantine wins even when other blocks are present", () => {
    const q: TrustCheckResult = {
      code: "untrusted",
      verdict: "block",
      message: "untrusted content",
      quarantine: true,
    };
    const mixed = [check("warn"), check("block"), q];
    expect(composeTrustDecision(mixed, { reviewRouted: true })).toBe(
      "quarantine"
    );
  });
});
