/**
 * @file test/preparation-cli-gate.test.ts
 * @description `llmwiki preparation gate` through the REAL built binary.
 *
 * WHY SUBPROCESS. An in-process test reaches a function; it says nothing about
 * whether commander ever registers the verb, whether the composition root calls
 * the registrar, whether a three-argument verb's positional order survives
 * commander's parsing, or whether the `--json` envelope survives contact with the
 * process's own stdout. Every one of those has failed in this command group
 * before — an envelope arrived prefixed with a status icon and never parsed, on
 * every invocation, with the in-process suites green.
 *
 * THE POSITIONAL ORDER IS THE NEW HAZARD HERE. This is the group's first verb
 * with three positionals, and a mis-ordered registration would bind the gate id
 * to the run id with no type error anywhere — so the success case asserts the
 * envelope names the gate the operator typed, and the durable record is read back
 * out of process.
 */

import { describe, expect, it } from "vitest";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import {
  SEED_GATE_ID, gateProject, gatedRun, readGateRun, type GateFixture,
} from "./preparation-gate-fixture.js";

/** Run the gate verb in the built binary against a fixture's root. */
function gate(fixture: GateFixture, gateId: string, decision: string, ...flags: string[]) {
  return runCLI(["preparation", "gate", fixture.binding.runId, gateId, decision, ...flags], fixture.root);
}

/** The parsed `--json` envelope, which is the contract a consumer depends on. */
function envelopeOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("preparation gate is reachable from the built binary", () => {
  it("advertises the verb in the group's help", async () => {
    const fixture = await gateProject("cligatehelp");
    try {
      const result = await runCLI(["preparation", "--help"], fixture.root);
      expectCLIExit(result, 0);
      expect(result.stdout).toContain("gate");
    } finally { await fixture.cleanup(); }
  });

  it("records the decision, exits 0, and emits a parseable envelope", async () => {
    const fixture = await gatedRun("cligaterecord");
    try {
      const result = await gate(fixture, SEED_GATE_ID, "approved", "--json");
      expectCLIExit(result, 0);
      const envelope = envelopeOf(result.stdout);
      // The positional order, pinned: run id and gate id are distinct values and
      // a swapped registration would put one where the other belongs.
      expect(envelope).toMatchObject({
        status: "recorded", runId: fixture.binding.runId, gateId: SEED_GATE_ID,
        decision: "approved", decisionIndex: 0,
      });
      // Read back OUT OF PROCESS: the durable half appears in no envelope field,
      // and this is the only assertion that survives a verb reporting success
      // without writing anything.
      const run = await readGateRun(fixture);
      expect(run.gateProofs).toHaveLength(1);
      expect(run.gateProofs[0]?.actor).toMatchObject({ id: "cli-operator", surface: "cli" });
    } finally { await fixture.cleanup(); }
  });

  it("exits 0 for a RECORDED rejection: the verb reports the write, not the choice", async () => {
    // The exit code answers "was the operator's decision recorded?", not "did
    // they approve?". A rejection that exited non-zero would make a script
    // recording a considered no look like a failed command.
    const fixture = await gatedRun("cligatereason");
    try {
      expectCLIExit(await gate(fixture, SEED_GATE_ID, "rejected", "--reason", "stale-input"), 0);
      expect((await readGateRun(fixture)).gateProofs[0]?.decision).toBe("rejected");
    } finally { await fixture.cleanup(); }
  });
});

describe("the gate verb exits non-zero on every refusal", () => {
  it("refuses a gate the plan does not declare and writes nothing", async () => {
    const fixture = await gatedRun("cligateunknown");
    try {
      const result = await gate(fixture, "no-such-gate", "approved", "--json");
      expectCLIExit(result, 1);
      expect(envelopeOf(result.stdout).status).toBe("refused");
      expect((await readGateRun(fixture)).gateProofs).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  it("refuses a decision outside the closed vocabulary", async () => {
    const fixture = await gatedRun("cligatebogus");
    try {
      const result = await gate(fixture, SEED_GATE_ID, "maybe", "--json");
      expectCLIExit(result, 1);
      expect(String(envelopeOf(result.stdout).reason)).toMatch(/not one of the three/);
    } finally { await fixture.cleanup(); }
  });
});

describe("handoff has no CLI verb, and that is deliberate", () => {
  it("is absent from the group rather than present-and-refusing", async () => {
    // The asymmetry recorded on the service, checked where an operator would
    // discover it. A verb that could only refuse would be worse than none:
    // its request carries typed compiled material with no textual operator form.
    const fixture = await gateProject("clinohandoff");
    try {
      const help = await runCLI(["preparation", "--help"], fixture.root);
      expect(help.stdout).not.toContain("handoff");
      // ANTI-VACUITY: the same help output DOES advertise the sibling verbs, so
      // this is not passing on an empty or unparsed stdout.
      expect(help.stdout).toContain("cancel");
    } finally { await fixture.cleanup(); }
  });
});
