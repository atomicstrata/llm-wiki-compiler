/**
 * @file test/portable/propose-generation.test.ts
 * @description Public-facade witnesses of proposal GENERATION on a freshly
 * registered local project: the premise is FORMAT 1 (an adopted, format-2
 * project refuses version-1 proposals by name before any generation, which
 * these tests neither weaken nor bypass).
 *
 * Everything goes through the public session (`openLocalProject` with the
 * host's model, `sources.add`, `allocateOperation`, `propose`, `candidates`,
 * `status`). The host model is a test double handed out ONE provider per
 * generation, in order, and counted: the host calls its model exactly once per
 * generation, so the count is the number of generations that ran. Overlapping
 * generations use SEPARATE gated providers (a gate is keyed by the source's
 * heading, so one shared provider would let a second call replace the first's
 * pending answer). Only `Date` is faked, and only where a lease must lapse;
 * timeouts, `setImmediate` and I/O stay real, and nothing sleeps.
 *
 * Witnessed: (1) a proposal from the source with a non-empty, inspectable
 * candidate, whose same-id replay returns the same receipt without generating;
 * (2) a same-id retry while the first generation holds a live lease answers
 * `in_progress` without asking the model, and the first then commits;
 * (3) once the host's lease ceiling has passed, a same-id successor takes the
 * operation over and commits, the late original is `generation_superseded`,
 * and replay and status both answer the successor's receipt.
 *
 * Each case runs under a NAMED durable budget (see
 * {@link DURABLE_PROPOSAL_CASE_TIMEOUT_MS}). Fail-fast is NOT a property of this
 * file or of the repository's default test run: the focused qualification
 * runner passed `--bail=1`, so there a run stopped at the first failure. The
 * `closing` guard only limits gated generation once cleanup begins; it does
 * not prove cancellation of a timed-out body, nor isolation across cases.
 */

import { describe, expect, it, setSystemTime } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import type { ProposalOutcome } from "../../src/portable/contracts.js";
import { DEFAULT_HOST_LIMITS } from "../../src/portable/host/control.js";
import { openLocalProject } from "../../src/portable/local.js";
import type { ProjectSession, WikiProject } from "../../src/portable/project/api.js";
import type { HostModel } from "../../src/portable/project/runtime.js";
import type { LLMProvider } from "../../src/utils/provider.js";
import { FixtureProvider } from "../fixtures/fixture-provider.js";
import { DeterministicProvider, overrideOf } from "../helpers/deterministic-provider.js";
import { expectNoUnhandledRejections, fatal, GatedProvider } from "../helpers/gated-provider.js";
import { makeFormatFixture, type FormatFixture } from "./disk-format-helpers.js";
import { prepared } from "./helpers.js";

/** The one source every proposal here compiles; its heading is the extraction gate's key. */
const HEADING = "Tidal Resonance";
const SOURCE = `# ${HEADING}\n\nTides resonate in narrow bays.\n`;
/** Past the host's lease ceiling, so a lease taken now has lapsed. */
const PAST_LEASE_MS = DEFAULT_HOST_LIMITS.maxLeaseMs + 1_000;
/**
 * The NAMED budget of each case here. Every case registers a project, publishes
 * a source and proposes through the product's durable ledger. On the slow
 * durable test volume one attempt measured 70 syncs taking 263.1 s (about
 * 3.76 s each), which exceeds the slow-durable profile's 90 s per test. A pass
 * under this budget shows the behaviour, not the reference 30 s or slow-profile
 * 90 s budget, and not product throughput.
 */
const DURABLE_PROPOSAL_CASE_TIMEOUT_MS = 300_000;
/** The cleanup hook's budget: it settles every owned proposal, whose durable writes outlive a failed case. */
const CLEANUP_HOOK_TIMEOUT_MS = 120_000;

let fixture: FormatFixture | undefined;
let session: ProjectSession | undefined;
/** Gated providers this test made: released at cleanup so no generation stays pending. */
const gates: GatedProvider[] = [];
/** Proposals this test started without awaiting at once: settled at cleanup, whatever happened. */
const owned: Promise<unknown>[] = [];
/**
 * Set when cleanup begins. A test timeout does not cancel a case's async
 * body; if a timed-out body starts another generation afterwards, its model is
 * a throwing provider, so it cannot reach a gate (or wait on one) again.
 */
let closing = false;

expectNoUnhandledRejections();
beforeEach(() => { closing = false; });
afterEach(async () => {
  closing = true;
  // A 400-shaped failure is never retried by the shared compiler, so a released call ends at once.
  for (const gate of gates.splice(0)) {
    try { gate.answer("extract", HEADING, fatal("released at cleanup")); } catch { /* this gate was never asked */ }
  }
  await Promise.allSettled(owned.splice(0));
  setSystemTime(); // back to the real clock (public main's replacement for vi.useRealTimers)
  await session?.close();
  session = undefined;
  await fixture?.cleanup();
  fixture = undefined;
}, CLEANUP_HOOK_TIMEOUT_MS);

/** A gated provider (extraction gated) this test owns. */
function gatedProvider(): GatedProvider {
  const gate = new GatedProvider(new Set(["extract"]));
  gates.push(gate);
  return gate;
}

/** Track a started proposal so cleanup settles it. */
function own(work: Promise<ProposalOutcome>): Promise<ProposalOutcome> {
  owned.push(work.catch(() => undefined));
  return work;
}

/**
 * A host model handing out `providers` in order, one per generation, and the
 * count of generations. Past them, or once cleanup began, it hands out a
 * provider that throws on any call.
 */
function boundedModel(providers: readonly LLMProvider[]): { model: HostModel; generations: () => number } {
  let calls = 0;
  const model: HostModel = () => {
    const provider = providers[calls++];
    return overrideOf(closing || provider === undefined ? new DeterministicProvider() : provider);
  };
  return { model, generations: () => calls };
}

/** A freshly registered (format 1) local project, opened publicly with `providers` as its model, holding SOURCE. */
async function project(providers: readonly LLMProvider[]): Promise<{ project: WikiProject; generations: () => number }> {
  fixture = await makeFormatFixture();
  expect((await fixture.record()).formatVersion).toBe(1);
  const bounded = boundedModel(providers);
  session = await openLocalProject(fixture.root, { controlRoot: fixture.controlRoot, model: bounded.model });
  const added = await session.project.sources.add({ operationId: await session.project.allocateOperation(), name: "tidal.md", upload: prepared(SOURCE) });
  expect(added.kind).toBe("committed");
  return { project: session.project, generations: bounded.generations };
}

/** The receipt of a proposed outcome, failing on any other. */
function proposed(outcome: ProposalOutcome): Extract<ProposalOutcome, { kind: "proposed" }> {
  if (outcome.kind !== "proposed") throw new Error(`expected a proposal, got ${JSON.stringify(outcome)}`);
  return outcome;
}

describe("a proposal on a format-1 local project", () => {
  it("proposes an inspectable candidate from the source, and a same-id replay returns the same receipt without generating", async () => {
    const { project: wiki, generations } = await project([new FixtureProvider()]);
    const operationId = await wiki.allocateOperation();
    const outcome = proposed(await wiki.propose({ operationId }));
    expect(outcome.receipt.candidates.length).toBeGreaterThan(0);
    const view = await wiki.candidates.get(operationId, outcome.receipt.candidates[0]!.id);
    if (!view.visible) throw new Error("the proposed candidate is not visible to its proposer");
    expect(view.value.draftBody).toContain(HEADING);
    expect(await wiki.propose({ operationId })).toEqual(outcome);
    expect(generations()).toBe(1);
  }, DURABLE_PROPOSAL_CASE_TIMEOUT_MS);
});

describe("a same-id proposal while the first generation holds its lease", () => {
  it("answers in_progress without asking the model, and the first generation then commits", async () => {
    const gate = gatedProvider();
    const { project: wiki, generations } = await project([gate]);
    const operationId = await wiki.allocateOperation();
    const first = own(wiki.propose({ operationId }));
    await gate.whenStarted("extract", 1);
    expect(await wiki.propose({ operationId })).toEqual({ kind: "in_progress", operationId });
    expect([generations(), gate.started("extract").length]).toEqual([1, 1]);
    gate.answer("extract", HEADING);
    expect((await first).kind).toBe("proposed");
    expect(generations()).toBe(1);
  }, DURABLE_PROPOSAL_CASE_TIMEOUT_MS);
});

describe("a same-id proposal once the first generation's lease has lapsed", () => {
  it("rejects a completed generation after its lease expires without a successor", async () => {
    const gate = gatedProvider();
    const { project: wiki, generations } = await project([gate]);
    const operationId = await wiki.allocateOperation();
    setSystemTime(Date.now());
    const late = own(wiki.propose({ operationId }));
    await gate.whenStarted("extract", 1);
    setSystemTime(Date.now() + PAST_LEASE_MS);
    gate.answer("extract", HEADING);
    expect(await late).toEqual({ kind: "rejected", reason: "generation_superseded" });
    expect(generations()).toBe(1);
  }, DURABLE_PROPOSAL_CASE_TIMEOUT_MS);

  it("takes over and commits; the late original is generation_superseded; replay and status answer the successor", async () => {
    const original = gatedProvider();
    const successor = gatedProvider();
    const { project: wiki, generations } = await project([original, successor]);
    const operationId = await wiki.allocateOperation();
    // Only Date is faked, as under vi.useFakeTimers({ toFake: ["Date"] }): pin it now, then move it past the lease.
    setSystemTime(Date.now());
    const late = own(wiki.propose({ operationId }));
    await original.whenStarted("extract", 1);
    setSystemTime(Date.now() + PAST_LEASE_MS);
    const next = own(wiki.propose({ operationId }));
    await successor.whenStarted("extract", 1);
    successor.answer("extract", HEADING);
    const won = proposed(await next);
    original.answer("extract", HEADING);
    expect(await late).toEqual({ kind: "rejected", reason: "generation_superseded" });
    expect(await wiki.propose({ operationId })).toEqual(won);
    expect(await wiki.status(operationId)).toEqual(won);
    expect([generations(), original.started("extract").length, successor.started("extract").length]).toEqual([2, 1, 1]);
  }, DURABLE_PROPOSAL_CASE_TIMEOUT_MS);
});
