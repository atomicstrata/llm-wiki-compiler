/**
 * @file test/preparation-sdk-prototype-authority.test.ts
 * @description The SDK's fail-closed default, against a POLLUTED prototype
 * chain.
 *
 * THE ESCALATION THIS FILE EXISTS FOR. `capturePreparationPrincipal` is the
 * hardened primitive that rejects accessors, proxies and non-plain prototypes,
 * and the facade allowlist-constructs a clean frozen record before handing one
 * over. That ordering was the defect: the facade READ the embedder's options
 * with ordinary property access, which walks the prototype chain, and then
 * laundered whatever it found into legitimate own-data. The guard saw a
 * perfectly well-formed principal and passed it. The gadget was cleaned up
 * BEFORE the thing that would have caught it.
 *
 * Three variants, each of which drove a real durable transition before the fix:
 *
 *   (a) no `preparation` option at all, with `Object.prototype.preparation` set;
 *   (b) `preparation: {}`, with `Object.prototype.grants` set;
 *   (c) `Object.prototype.id` set, impersonating the local operator's identity
 *       onto the durable actor record.
 *
 * WHAT HELD, and is asserted here so it stays held: the `surface` stamp. A
 * polluted `surface` moves nothing, because the facade never reads one and the
 * service compares the captured surface against its own fixed value.
 *
 * AN UNPOLLUTED SUITE CANNOT TELL FIXED FROM BROKEN. Every other test in this
 * lane passes against the vulnerable code, which is exactly why these are
 * written as pollution fixtures rather than as a code comment.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createWiki } from "../src/sdk/wiki.js";
import {
  MUTATING_GRANTS, expectMissingGrant, expectNoGateProof, expectRunFailed, expectStagedBy,
  projectWithRun, stageDocuments, stageableProject, stagedAllowance,
} from "./preparation-sdk-fixture.js";

/**
 * Every prototype key these fixtures plant, removed after each test.
 *
 * `pollute` is keyed to this list on purpose: planting a key that is not here
 * would leak the gadget into every later test in the process. The test
 * type-check caught exactly that when the allowance case was added.
 *
 * STILL HAND-WRITTEN, and that is now checked rather than trusted — see
 * "sweeps every own-gated read" below. The list itself cannot be derived,
 * because it is deliberately a SUPERSET: `surface` is here as a negative
 * control (it is never own-read, and the point is that planting it changes
 * nothing). What IS derived is the obligation — every key the SDK own-gates in
 * production must appear here AND be planted by some test, or that control goes
 * red. So the maintenance point is real but it can no longer be forgotten
 * silently.
 */
const PLANTED_KEYS = [
  "preparation", "id", "grants", "surface", "controlTransitionAllowance",
  "planDocument", "seedDocument",
  // The gate input's four fields and the handoff obligation set's five. Both
  // requests are caller OBJECTS reaching a durable write, which is the shape
  // this file exists for.
  "runId", "gateId", "decision", "reasonCode",
  "compilation", "authorities", "preparationEvidence", "payloads", "supersedesBundleId",
] as const;

afterEach(() => {
  for (const key of PLANTED_KEYS) {
    delete (Object.prototype as Record<string, unknown>)[key];
  }
});

/** Plant one key on `Object.prototype`, as a gadget chain would. */
function pollute(key: (typeof PLANTED_KEYS)[number], value: unknown): void {
  Object.defineProperty(Object.prototype, key, {
    value, writable: true, configurable: true, enumerable: false,
  });
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The name a call expression invokes, including a one-level property access. */
function calleeName(expression: ts.Expression): string {
  return ts.isPropertyAccessExpression(expression)
    ? `${expression.expression.getText()}.${expression.name.text}`
    : expression.getText();
}

/**
 * The string literal at argument `index` of every `callee(...)` call.
 *
 * The INDEX is required rather than scanning every argument, because these
 * calls carry values as well as keys: a first version collected both and
 * decided `"cli-operator"` was a property being gated. A derivation that reads
 * the wrong position is worse than a hand-written list, because it looks
 * derived.
 */
function keyArgumentsOf(source: string, callee: string, index: number): string[] {
  const parsed = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === callee) {
      const argument = node.arguments[index];
      if (argument !== undefined && ts.isStringLiteral(argument)) keys.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return keys;
}

/** One repo-relative source file's text. */
async function sourceOf(module: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, module), "utf8");
}

/**
 * Every caller-supplied key the SDK own-gates in PRODUCTION, derived from source.
 *
 * `own(input, "…")` in the facade and `Object.hasOwn(options, "…")` in the
 * composition root are the two spellings the fix uses. Deriving them is what
 * turns this file from a list someone has to remember into an obligation the
 * suite enforces.
 */
async function ownGatedKeys(): Promise<string[]> {
  return [...new Set([
    ...keyArgumentsOf(await sourceOf("src/sdk/preparation-facade.ts"), "own", 1),
    ...keyArgumentsOf(await sourceOf("src/sdk/core.ts"), "Object.hasOwn", 1),
    ...keyArgumentsOf(await sourceOf("src/sdk/wiki.ts"), "Object.hasOwn", 1),
  ])].sort();
}

/** Every key some test in THIS file actually plants. */
async function pollutedKeys(): Promise<Set<string>> {
  const source = await sourceOf("test/preparation-sdk-prototype-authority.test.ts");
  return new Set(keyArgumentsOf(source, "pollute", 0));
}

describe("a polluted prototype cannot grant preparation authority", () => {
  it("REFUSES when the whole `preparation` option comes from the prototype", async () => {
    const { cwd, binding } = await projectWithRun("protoall");
    pollute("preparation", { id: "ghost", grants: ["preparation.run"] });
    // No `preparation` key on the literal at all — the read must not find one.
    const wiki = createWiki({ root: cwd });
    await expectMissingGrant(wiki.failPreparation(binding.runId), cwd, binding);
  });

  it("REFUSES when only `grants` comes from the prototype", async () => {
    const { cwd, binding } = await projectWithRun("protogrants");
    pollute("grants", ["preparation.run"]);
    const wiki = createWiki({ root: cwd, preparation: {} });
    await expectMissingGrant(wiki.failPreparation(binding.runId), cwd, binding);
  });

  it("does not let a prototype `id` impersonate the local operator", async () => {
    // The durable actor record is the target here, not the grant: an SDK write
    // that lands as `cli-operator` misattributes every transition it makes.
    const cwd = await stageableProject("protoid");
    pollute("id", "cli-operator");
    const wiki = createWiki({ root: cwd, preparation: { grants: MUTATING_GRANTS } });
    await expectStagedBy(wiki, cwd, { id: "sdk-consumer", surface: "sdk" });
  });

  it("stages the DEFAULT budget when the prototype offers one and the caller does not", async () => {
    // NOT AN ESCALATION, and worth a test anyway. The stage request read
    // `input.controlTransitionAllowance` plainly, so a planted value became the
    // run's DURABLE control-transition budget for a caller who named none —
    // 3 instead of 16, silently, verified off disk. Inflation is refused by the
    // substrate's cap; REDUCTION just quietly shrinks what the run may do.
    //
    // The same own-read that protects the grants protects this, and the fix was
    // one function away from where it already lived.
    const cwd = await stageableProject("protoallowance");
    pollute("controlTransitionAllowance", 3);
    const wiki = createWiki({ root: cwd, preparation: { grants: MUTATING_GRANTS } });
    const result = await wiki.stagePreparation(await stageDocuments());
    expect(result.status).toBe("staged");
    expect(await stagedAllowance(cwd, (result as { workspaceId: string }).workspaceId)).toBe(16);
  });

  it("REFUSES to stage a PLAN the caller never supplied", async () => {
    // THE MOST SERIOUS OF THE FAMILY, and it was gated in code with nothing
    // pinning it: reverting both document reads to plain access left the full
    // suite green. With `Object.prototype.planDocument` planted, a caller who
    // supplied only a seed stages a run built from content it never chose —
    // durable, and executed under whatever grants the embedder legitimately
    // holds. The allowance case was a budget field; this is the entire plan.
    const cwd = await stageableProject("protoplandoc");
    const { planDocument, seedDocument } = await stageDocuments();
    pollute("planDocument", planDocument);
    const wiki = createWiki({ root: cwd, preparation: { grants: MUTATING_GRANTS } });

    expect(await wiki.stagePreparation({ seedDocument } as never))
      .toEqual({ status: "refused", reason: "no plan document was supplied" });
    expect((await createWiki({ root: cwd }).listPreparations()).runs).toEqual([]);
  });

  it("REFUSES to stage against a SEED the caller never supplied", async () => {
    // The sibling read. A planted seed is the bytes the plan's declared input
    // set is checked against, so it decides what the run's initial evidence
    // durably is.
    const cwd = await stageableProject("protoseeddoc");
    const { planDocument, seedDocument } = await stageDocuments();
    pollute("seedDocument", seedDocument);
    const wiki = createWiki({ root: cwd, preparation: { grants: MUTATING_GRANTS } });

    expect(await wiki.stagePreparation({ planDocument } as never))
      .toEqual({ status: "refused", reason: "no seed document was supplied" });
    expect((await createWiki({ root: cwd }).listPreparations()).runs).toEqual([]);
  });

  it("keeps the surface stamp immune, as it already was", async () => {
    // The control that HELD before the fix, and it needs a LEGITIMATE grant to
    // say anything: with grants also polluted, this test would pass on the
    // missing-grant refusal and prove nothing about the surface at all. So the
    // grant is real and own, and only `surface` is planted — leaving exactly one
    // thing the outcome can be about.
    //
    // If a caller-supplied surface were ever read, the principal would claim
    // `cli` on an `sdk` service and the service's own comparison would refuse
    // with `invalid-principal`. It succeeds, and records `sdk`.
    const { cwd, binding } = await projectWithRun("protosurface");
    pollute("surface", "cli");
    const wiki = createWiki({
      root: cwd, preparation: { id: "sdk-test", grants: MUTATING_GRANTS },
    });
    await expectRunFailed(wiki.failPreparation(binding.runId), cwd, binding);
  });
});

describe("a polluted prototype cannot supply a gate decision or a bundle", () => {
  it("REFUSES a gate the caller named no part of", async () => {
    const { cwd, binding } = await projectWithRun("protogate");
    // Everything the decision needs, planted. With ordinary property reads the
    // facade would have decided a real gate on a real run for a caller who
    // supplied an empty object — and the durable proof would name their reason.
    pollute("runId", binding.runId);
    pollute("gateId", "review");
    pollute("decision", "approved");
    pollute("reasonCode", "planted");
    const wiki = createWiki({ root: cwd, preparation: { grants: ["preparation.gate.decide"] } });
    const result = await wiki.gatePreparation({} as never);
    expect(result.status).toBe("refused");
    await expectNoGateProof(cwd, binding);
  });

  it("REFUSES a handoff whose obligation set came from the prototype", async () => {
    const { cwd, binding } = await projectWithRun("protohandoff");
    // The escalation this one would be: the gadget's payload BYTES staged into
    // an immutable bundle under reserved identities, for a caller that passed an
    // empty object. Typed-and-required is not the same as present on a published
    // JavaScript surface.
    pollute("compilation", {});
    pollute("authorities", {});
    pollute("preparationEvidence", []);
    pollute("payloads", new Map());
    pollute("supersedesBundleId", undefined);
    const wiki = createWiki({ root: cwd, preparation: { grants: ["preparation.run"] } });
    const result = await wiki.handoffPreparation(binding.runId, {} as never);
    expect(result).toMatchObject({ status: "refused" });
    expect(result.status === "refused" && result.reason).toMatch(/obligation set is incomplete/);
  });
});

describe("the pollution sweep is checked against the code it protects", () => {
  it("plants every own-gated read, derived from the production source", async () => {
    // THE MAINTENANCE POINT, made self-enforcing. Three own-gated reads were
    // added across two rounds and each time the sweep list had to be updated by
    // hand — the allowance was caught by the test type-check, the two documents
    // were caught by review, and nothing would have caught the next one.
    //
    // A new `own(...)` read in the facade now turns this red until someone
    // plants it here. Note what it does NOT prove: that the resulting test
    // asserts anything USEFUL about that key. It forces the key in front of a
    // human; it cannot force a good assertion.
    const gated = await ownGatedKeys();
    // ANTI-VACUITY: an empty derivation would satisfy the subset check below
    // perfectly, which is how a broken parse would certify itself.
    expect(gated).toEqual([
      "authorities", "compilation", "controlTransitionAllowance", "decision", "gateId",
      "grants", "id", "payloads", "planDocument", "preparation", "preparationEvidence",
      "reasonCode", "runId", "seedDocument", "supersedesBundleId",
    ]);
    const planted = await pollutedKeys();
    expect(gated.filter((key) => !planted.has(key))).toEqual([]);
  });

  it("cleans up every key any test plants", async () => {
    // The other half: a planted key missing from PLANTED_KEYS leaks the gadget
    // into every later test in the process.
    const planted = [...await pollutedKeys()].sort();
    expect(planted.filter((key) => !PLANTED_KEYS.includes(key as never))).toEqual([]);
    // `surface` is deliberately in PLANTED_KEYS and NOT own-gated: it is the
    // negative control, and the superset is intentional rather than drift.
    expect(PLANTED_KEYS).toContain("surface");
    expect(await ownGatedKeys()).not.toContain("surface");
  });
});
