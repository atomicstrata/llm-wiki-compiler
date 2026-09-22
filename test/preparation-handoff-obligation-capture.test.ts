/**
 * @file test/preparation-handoff-obligation-capture.test.ts
 * @description The handoff obligation set is captured to its LEAVES before the
 * first await — measured by walking the whole set and mutating every one.
 *
 * WHY A WALKER RATHER THAN CASES. The defect was reported as one field, and one
 * field is what a case would have pinned: mutate
 * `authorities.operationRun.controlTransitionAllowance` between the call and the
 * await, and the durable genesis run records the new value. But the cause was
 * never that field — it was that two of the four roots were retained WHOLE by
 * reference and the other two were copied exactly one level deep. A fix aimed at
 * the reported field passes that case and leaves the rest open.
 *
 * So this walks the obligation set, mutates every reachable leaf after the
 * public boundary, and asserts the count that survived is ZERO. It is a property
 * over the set rather than evidence about a member of it.
 *
 * THE PAYLOAD BYTES ARE NOT ONE MORE LEAF. `payloads` is keyed by the sha256 of
 * its own values, so a byte mutated after capture leaves the key asserting
 * content the bundle no longer carries — a correctness failure in the
 * content-addressing rather than a changed value. A fix that deep-captures the
 * other roots and keeps `new Map(payloads)` passes the reported reproduction and
 * still fails here.
 */

import { describe, it, expect } from "vitest";
import { createPreparationService } from "../src/preparations/service.js";
import { createWiki } from "../src/sdk/wiki.js";
import type { PreparationServiceV1 } from "../src/preparations/service.js";
import type { PreparationHandoffObligationsV1 } from "../src/preparations/service-handoff.js";
import type { PreparationRunBinding } from "../src/preparations/run-types.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import {
  handoffObligations, readCreatedGenesisRun, stageReadyPreparation,
} from "./preparations/handoff-fixture.js";

const root = useTempRoot();

/** Mutate immediately after the synchronous service boundary, before awaiting its result. */
function handoffThenMutate(
  binding: PreparationRunBinding, obligations: PreparationHandoffObligationsV1,
  leaves: ReturnType<typeof leavesOf>,
) {
  expect(leaves.length).toBeGreaterThan(1);
  const pending = service(root.dir).handoff({ runId: binding.runId, obligations });
  for (const leaf of leaves) leaf.mutate();
  return pending;
}

/** Read the durable result, mapping service names explicitly to the substrate's outcome. */
async function genesisAfterHandoff(binding: PreparationRunBinding, pending: ReturnType<PreparationServiceV1["handoff"]>) {
  const outcome = await pending;
  if (outcome.status === "refused") throw new Error(`refused: ${outcome.reason}`);
  return readCreatedGenesisRun(root.dir, binding, {
    outcome: outcome.status, handoffId: outcome.handoffId, bundleId: outcome.bundleId,
    operationRunId: outcome.operationRunId, bundleManifestDigest: outcome.bundleManifestDigest,
  });
}

/** The service a granted host would construct — the run grant is what handoff costs. */
function service(dir: string): PreparationServiceV1 {
  return createPreparationService({
    root: dir, surface: "sdk",
    principals: { principalFor: () => ({ id: "host-2", surface: "sdk", grants: ["preparation.run"] }) },
  });
}

/**
 * Reconstruct the obligation set as a MUTABLE tree — the hostile caller's object.
 *
 * The fixture freezes what it builds, which makes it the wrong instrument here:
 * a frozen caller cannot mutate anything, so the walk would measure the
 * fixture's immutability rather than the capture's. A real caller passes an
 * object it owns and can still write to, and that is what the boundary has to
 * survive. Maps and byte buffers are rebuilt in kind so the shape the service
 * receives is unchanged; adapters are carried by reference because they are code.
 */
function mutableCopy<T>(value: T, path = ""): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return Buffer.from(value) as unknown as T;
  if (value instanceof Map) {
    if (path === "compilation.adapters") return new Map(value) as unknown as T;
    return new Map(
      [...value].map(([key, entry]) => [key, mutableCopy(entry, `${path}[${String(key)}]`)]),
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((item, i) => mutableCopy(item, `${path}[${i}]`)) as unknown as T;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, mutableCopy(entry, path === "" ? key : `${path}.${key}`)]),
  ) as T;
}

/**
 * Assert the caller's own object really took the mutation.
 *
 * WITHOUT THIS A PASSING CASE MEANS THE WRONG THING. "no tampered value reached
 * the bundle" is trivially true if no tampering ever happened — a leaf whose
 * `mutate()` silently no-ops against a frozen sub-object, a getter, or a shape
 * that changed under the walker leaves the case green while witnessing nothing,
 * and a length check cannot see it because the leaves exist and simply do not
 * take the write.
 *
 * Pinning it converts the proposition from *"nothing tampered arrived"* into
 * *"tampering definitely happened and still did not arrive"* — which is the one
 * the case is named for.
 */
function expectMutationLanded(root: unknown, where: string): void {
  expect(JSON.stringify(root), `${where}: no mutation landed on the caller's object`)
    .toContain("-tampered");
}

/** One reachable leaf: where it lives, and how to change it in place. */
interface Leaf {
  readonly path: string;
  mutate(): void;
  readonly read: () => unknown;
}

/**
 * Every mutable leaf reachable from the obligation set, with a mutation for it.
 *
 * DERIVED BY WALKING rather than listed, so a field added to the obligation
 * shape is covered without anybody remembering to add a case. Adapters are
 * skipped by design — they are core-constructed code the host injects, not
 * caller-authored data, and their methods are the point of them.
 */
function leavesOf(value: unknown, path = "", found: Leaf[] = []): Leaf[] {
  if (value === null || typeof value !== "object") return found;
  if (value instanceof Map) return mapLeaves(value, path, found);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const here = path === "" ? key : `${path}.${key}`;
    const leaf = scalarLeaf(value as Record<string, unknown>, key, entry, here);
    if (leaf === null) leavesOf(entry, here, found);
    else found.push(leaf);
  }
  return found;
}

/** Walk a Map: payload buffers are byte leaves, adapters are code and skipped. */
function mapLeaves(value: ReadonlyMap<unknown, unknown>, path: string, found: Leaf[]): Leaf[] {
  if (path === "compilation.adapters") return found;
  for (const [key, entry] of value) {
    const here = `${path}[${String(key)}]`;
    if (entry instanceof Uint8Array) {
      found.push({ path: here, mutate: () => { entry[0] = (entry[0] ?? 0) ^ 0xff; }, read: () => entry[0] });
    } else {
      leavesOf(entry, here, found);
    }
  }
  return found;
}

/** One scalar leaf and the mutation for it, or null when the value is a subtree. */
function scalarLeaf(
  owner: Record<string, unknown>, key: string, entry: unknown, path: string,
): Leaf | null {
  const read = (): unknown => entry;
  if (typeof entry === "number") return { path, read, mutate: () => { owner[key] = entry + 1; } };
  if (typeof entry === "string") return { path, read, mutate: () => { owner[key] = `${entry}-tampered`; } };
  if (typeof entry === "boolean") return { path, read, mutate: () => { owner[key] = !entry; } };
  return null;
}

describe("the obligation set is captured to its leaves", () => {
  it("finds a reachable leaf set worth measuring — anti-vacuity", async () => {
    // WITHOUT THIS, A FIX THAT SHRANK THE REACHABLE STRUCTURE WOULD READ AS
    // SUCCESS. Zero surviving mutations is trivially true of an empty walk, so
    // the walk itself has to be shown non-trivial, and shown to reach the field
    // the external reproduction used.
    const binding = await stageReadyPreparation(root.dir);
    const leaves = leavesOf(mutableCopy(handoffObligations(binding)));
    expect(leaves.length).toBeGreaterThan(1);
    expect(leaves.map((leaf) => leaf.path))
      .toContain("authorities.operationRun.controlTransitionAllowance");
  });

  it("commits the ORIGINAL values after every leaf is mutated post-boundary", async () => {
    // THE HOSTILE PUBLIC-BOUNDARY REGRESSION, generalized. The reported
    // reproduction mutated one field; this mutates EVERY reachable leaf between
    // the synchronous call and the await, then reads the durable genesis run.
    //
    // MEASURED AT THE DURABLE ARTIFACT, NOT AT THE CALLER'S OBJECT. Comparing
    // the caller's tree before and after only proves the mutation happened —
    // the service's copy is not reachable from here, and for a byte leaf the
    // read dereferences the same buffer twice and reports the mutation as
    // survival. What settles it is what got committed.
    const binding: PreparationRunBinding = await stageReadyPreparation(root.dir);
    const obligations: PreparationHandoffObligationsV1 = mutableCopy(handoffObligations(binding));
    const original = obligations.authorities.operationRun.controlTransitionAllowance;
    const leaves = leavesOf(obligations);
    const pending = handoffThenMutate(binding, obligations, leaves);
    const genesis = await genesisAfterHandoff(binding, pending);

    // The caller really did change it — without this the case passes against a
    // mutation that silently failed.
    expect(obligations.authorities.operationRun.controlTransitionAllowance).not.toBe(original);
    // The service result and the substrate result carry the same identities under
    // different field names — `status` versus `outcome` — so the reader takes the
    // substrate shape rather than a cast that would hide a real mismatch.
    expect(genesis.controlTransitionAllowance).toBe(original);
  });

  it("captures the EVIDENCE elements, not just which refs are present", async () => {
    // THE ROOT THE OTHER CASES CANNOT SEE. Evidence aliasing does not touch the
    // control-transition allowance and has no digest binding of its own, so the
    // omnibus case and the payload case both stay green when `[...arr]` replaces
    // the deep capture. This mutates ONLY the evidence, so nothing else can
    // account for the result.
    // THE FIXTURE NOW CARRIES ONE, and until it did this root was
    // UNWITNESSABLE rather than merely uncovered: every handoff fixture set
    // `preparationEvidence: []`, so reverting the deep capture left the whole
    // suite green because there was nothing to alias. A missing root looks
    // exactly like a root with nothing wrong.
    const binding = await stageReadyPreparation(root.dir);
    const mutated = mutableCopy(handoffObligations(binding));
    expect(leavesOf(mutated.preparationEvidence, "preparationEvidence").length).toBeGreaterThan(0);

    const pending = service(root.dir).handoff({ runId: binding.runId, obligations: mutated });
    for (const leaf of leavesOf(mutated.preparationEvidence, "preparationEvidence")) leaf.mutate();
    expectMutationLanded(mutated.preparationEvidence, "preparationEvidence");
    // Two different runs digest differently by construction, so the comparison
    // that binds is the STAGED EVIDENCE itself: the bundle must carry the refs
    // as they stood at the boundary, not as the caller later rewrote them.
    const staged = await genesisAfterHandoff(binding, pending);
    expect(JSON.stringify(staged)).not.toContain("-tampered");
  });

  it("captures COMPILATION alone — nothing it uniquely controls reaches the bundle", async () => {
    // ONE ROOT, ON ITS OWN. The omnibus case mutates every leaf, so it dies if
    // ANY root is aliased — which makes it evidence about the conjunction and
    // about no member of it. This mutates `compilation` and nothing else, so
    // the only thing that can turn it red is `compilation`'s own capture.
    const binding = await stageReadyPreparation(root.dir);
    const obligations = mutableCopy(handoffObligations(binding));
    const leaves = leavesOf(obligations.compilation, "compilation");
    const pending = handoffThenMutate(binding, obligations, leaves);
    expectMutationLanded(obligations.compilation, "compilation");
    const staged = await genesisAfterHandoff(binding, pending);
    expect(JSON.stringify(staged)).not.toContain("-tampered");
  });

  it("captures AUTHORITIES alone — the allowance it uniquely controls is the original", async () => {
    // ONE ROOT, ON ITS OWN, asserting on a value only this root supplies:
    // `operationRun.controlTransitionAllowance` is written into the durable
    // genesis run and comes from nowhere else in the obligation set.
    const binding = await stageReadyPreparation(root.dir);
    const obligations = mutableCopy(handoffObligations(binding));
    const original = obligations.authorities.operationRun.controlTransitionAllowance;
    const leaves = leavesOf(obligations.authorities, "authorities");
    const pending = handoffThenMutate(binding, obligations, leaves);
    const staged = await genesisAfterHandoff(binding, pending);
    // The caller really did change it — without this the case passes against a
    // mutation that silently failed.
    expect(obligations.authorities.operationRun.controlTransitionAllowance).not.toBe(original);
    expect(staged.controlTransitionAllowance).toBe(original);
  });

  it("copies the payload BYTES, so a post-boundary write cannot break the digest", async () => {
    // THE ASSERTION HAD TO CHANGE, because the first version was vacuous: it
    // compared the caller's buffer against a copy of itself, which differs after
    // any mutation whether or not the service captured anything. It measured the
    // mutation, not the capture.
    //
    // What the capture actually buys is that a post-boundary write is HARMLESS.
    // `payloads` is keyed by the sha256 of its values, so an aliased buffer
    // rewritten after the boundary makes the staged content stop matching its
    // key and the substrate refuses with a payload digest mismatch. Succeeding
    // is therefore the property — and it is exactly what a shallow `new Map`
    // breaks, which the reported reproduction never touched.
    const binding = await stageReadyPreparation(root.dir);
    const obligations = mutableCopy(handoffObligations(binding));
    const [, bytes] = [...obligations.payloads][0] ?? [];
    if (bytes === undefined) throw new Error("fixture has no payload");

    const before = bytes[0];
    const pending = service(root.dir).handoff({ runId: binding.runId, obligations });
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    // ANTI-VACUITY, against the ORIGINAL byte. The previous form compared the
    // mutated byte to a zeroed copy of itself, which asserts only that it is
    // non-zero — true of almost any byte, and silent if the write never landed.
    // Comparing to what was there before is the fact the case depends on.
    expect(bytes[0]).not.toBe(before);
    const outcome = await pending;
    expect(outcome.status).not.toBe("refused");
  });

});

describe("an accessor at the public boundary never runs", () => {
  /** An obligation set whose `authorities` is an own GETTER, with a witness. */
  function withAuthoritiesGetter(base: PreparationHandoffObligationsV1): {
    obligations: PreparationHandoffObligationsV1; reads: () => number;
  } {
    let reads = 0;
    const { authorities, ...rest } = base;
    const obligations = Object.defineProperty({ ...rest }, "authorities", {
      enumerable: true, configurable: true,
      get() { reads += 1; return authorities; },
    }) as PreparationHandoffObligationsV1;
    return { obligations, reads: () => reads };
  }

  it("REFUSES with the typed reason, and the getter is never invoked", async () => {
    // OBSERVING A THROW IS NOT OBSERVING A REFUSAL. Destructuring is a [[Get]],
    // so the boundary used to invoke this getter on the way to the guard that
    // exists to refuse accessors — and a getter that threw escaped as an untyped
    // error out of a surface documented to return `{status: "refused"}`.
    //
    // The counter is the half that matters: a refusal alone is satisfied by code
    // that ran the accessor and then rejected its result, which is a different
    // and weaker property than never running it.
    const binding = await stageReadyPreparation(root.dir);
    const { obligations, reads } = withAuthoritiesGetter(handoffObligations(binding));
    const outcome = await service(root.dir).handoff({ runId: binding.runId, obligations });
    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") return;
    expect(outcome.reason).toBe("the handoff obligation set is incomplete");
    expect(reads(), "the accessor was invoked at the boundary").toBe(0);
  });

  it("REFUSES a THROWING accessor rather than letting it escape untyped", async () => {
    // The externally reproduced case. A getter that throws must not become the
    // caller's error: the boundary owns the contract, so the throw has to become
    // the documented refusal.
    const binding = await stageReadyPreparation(root.dir);
    const { authorities: _drop, ...rest } = handoffObligations(binding);
    const obligations = Object.defineProperty({ ...rest }, "authorities", {
      enumerable: true, configurable: true,
      get() { throw new Error("accessor executed at the boundary"); },
    }) as PreparationHandoffObligationsV1;
    const outcome = await service(root.dir).handoff({ runId: binding.runId, obligations });
    expect(outcome).toEqual({
      status: "refused", reason: "the handoff obligation set is incomplete",
    });
  });

  it("does not invoke an accessor nested on COMPILATION either", async () => {
    // THE SECOND DESTRUCTURE. `const { adapters, ...data } = compilation` is its
    // own [[Get]] over every remaining own property, so fixing only the outer
    // read leaves this one running accessors.
    let reads = 0;
    const binding = await stageReadyPreparation(root.dir);
    const base = handoffObligations(binding);
    const { targets: _drop, ...restCompilation } = base.compilation;
    const compilation = Object.defineProperty({ ...restCompilation }, "targets", {
      enumerable: true, configurable: true,
      get() { reads += 1; return base.compilation.targets; },
    });
    const outcome = await service(root.dir).handoff({
      runId: binding.runId,
      obligations: { ...base, compilation } as PreparationHandoffObligationsV1,
    });
    expect(outcome.status).toBe("refused");
    expect(reads, "the compilation accessor was invoked").toBe(0);
  });

  it("REFUSES a payload container that is not a Map, rather than throwing", async () => {
    // The payload walk used to iterate whatever it was handed. A caller-supplied
    // value that is not a real `Map` threw out of a boundary whose contract says
    // it returns a refusal — the same false-contract shape as the accessor, in a
    // different field.
    const binding = await stageReadyPreparation(root.dir);
    const outcome = await service(root.dir).handoff({
      runId: binding.runId,
      obligations: { ...handoffObligations(binding), payloads: {} } as unknown as PreparationHandoffObligationsV1,
    });
    expect(outcome).toEqual({
      status: "refused", reason: "the handoff obligation set is incomplete",
    });
  });

  it("REFUSES an ITERABLE that is not a Map — the case the catch cannot see", async () => {
    // THE DISCRIMINATING INPUT. A plain object makes `for…of` throw, so the
    // try/catch alone already refuses it and a case built on one witnesses the
    // catch rather than the type check. An ARRAY OF PAIRS iterates perfectly
    // well and would be silently accepted as a payload map — same shape, no
    // error, wrong container. Only the `instanceof Map` test refuses it.
    const binding = await stageReadyPreparation(root.dir);
    const real = handoffObligations(binding);
    const outcome = await service(root.dir).handoff({
      runId: binding.runId,
      obligations: { ...real, payloads: [...real.payloads] } as unknown as PreparationHandoffObligationsV1,
    });
    expect(outcome).toEqual({
      status: "refused", reason: "the handoff obligation set is incomplete",
    });
  });

  it("does not invoke an accessor on the SDK surface either", async () => {
    // THE SIBLING BOUNDARY. `own()` used to pair `Object.hasOwn` with
    // `source[key]`: the first stops a prototype-planted gadget and the second
    // RUNS an own accessor, laundering its result into a clean record before the
    // hardened guard sees it.
    let reads = 0;
    const options = Object.defineProperty({ id: "sdk-test" }, "grants", {
      enumerable: true, configurable: true,
      get() { reads += 1; return ["preparation.run"]; },
    });
    const wiki = createWiki({ root: root.dir, preparation: options as never });
    // The accessor's value must not become authority: with it unread, the
    // embedder holds no grants and the operation refuses.
    await expect(wiki.listPreparations()).resolves.toBeDefined();
    expect(reads, "the SDK read the accessor").toBe(0);
  });
});
