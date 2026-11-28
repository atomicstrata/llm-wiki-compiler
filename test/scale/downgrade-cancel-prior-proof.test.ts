/**
 * @file test/scale/downgrade-cancel-prior-proof.test.ts
 * @description Witnesses of the P5 prior proof (and the complete-attempt
 * manifest it binds to) through the real fenced no-move proof `proveNoMove`
 * and its real `stagingEvidence`, on plainly written leaves: the code under
 * test only reads.
 *
 * The plan is a real parsed plan over the shared plain fixture's inventory,
 * with only its indexed facts and its first prior replaced: the stores and
 * pins are the REAL `indexedFacts` of the fixture's own empty
 * `.llmwiki/indexed`, so the incumbent-authority check (P4) passes on its own
 * terms and each case reaches the prior proof. Digests, sizes and object
 * identities are the files' actual ones.
 *
 * Witnessed: an absent prior is accepted, and refused once present; a present
 * prior is accepted with its observed identity when its digest and size match,
 * and refused when either differs (each alone: another digest at the same
 * size, and the plan's digest with another recorded size); a complete stage manifest is accepted (the
 * manifest branch) and refused when its units are not the plan's; and a prior
 * the manifest bound by identity is accepted, then refused once the same bytes
 * sit at a different inode (the old one is kept alive at another path, so it
 * cannot be reused).
 *
 * Proof limit: read validation only. Nothing here qualifies durable
 * cancellation, power loss, the export, or the fenced compare-and-swap.
 */

import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "../config/storage-profile-hooks.js";
import { INDEXED_DIR } from "../../src/segments/contracts.js";
import { intentOf } from "../../src/scale/downgrade-apply.js";
import { proveNoMove } from "../../src/scale/downgrade-cancel-proof.js";
import { identityAt, sameObject, type ObjectIdentityV1 } from "../../src/scale/downgrade-fs.js";
import { indexedFacts } from "../../src/scale/downgrade-indexed-facts.js";
import { stagedPath } from "../../src/scale/downgrade-journal.js";
import { buildDowngradePlan, type DowngradePlanV1 } from "../../src/scale/downgrade-plan.js";
import { plainProject, plant, plantLeaf, sha256, type CancelProject } from "./cancel-helpers.js";

const PRIOR_TEXT = "prior";
const projects: CancelProject[] = [];
afterEach(async () => { for (const project of projects.splice(0)) await project?.remove(); });

/** One proving fixture: its root, its plan, the plan's evidence directory, and the first prior's path. */
interface Proving { root: string; plan: DowngradePlanV1; dir: string; priorRel: string }

/** A plain project whose plan carries the fixture's REAL empty indexed facts and `prior` as its first prior. */
async function proving(prior: { sha256: string | null; bytes: number }): Promise<Proving> {
  const base = await plainProject({ intent: false });
  projects.push(base);
  await mkdir(path.join(base.root, INDEXED_DIR), { recursive: true });
  const facts = await indexedFacts(base.root);
  expect(facts.blockers).toEqual([]);
  const [first, ...rest] = base.plan.inventory.priors;
  const priors = [{ relPath: first!.relPath, ...prior }, ...rest];
  const plan = buildDowngradePlan(base.root, { ...base.plan.inventory, stores: facts.stores, pins: facts.pins, priors });
  const dir = intentOf(plan).dir;
  await plant(base.root, path.posix.join(dir, "plan.json"), `${JSON.stringify(plan)}\n`);
  return { root: base.root, plan, dir, priorRel: first!.relPath };
}

/** A fixture whose first prior is present: PRIOR_TEXT, with its real digest and size. */
const presentPrior = (): Promise<Proving> => proving({ sha256: sha256(PRIOR_TEXT), bytes: Buffer.byteLength(PRIOR_TEXT) });

/** The refusal message of the no-move proof, or "accepted". */
async function refusalOf(fixture: Proving): Promise<string> {
  return proveNoMove(fixture.root, fixture.dir, fixture.plan, []).then(() => "accepted", (error: Error) => error.message);
}

/** The P5 refusal message for `detail`. */
const p5 = (detail: string): string => `scale_downgrade_not_cancellable: P5: ${detail}; nothing was written`;

/** Write a complete attempt 1: a staged file at the unit's staged path and a stage manifest binding it (and `priorIdentity`). */
async function stageComplete(fixture: Proving, options: { unitSha?: string; priorIdentity?: ObjectIdentityV1 | null } = {}): Promise<void> {
  const unit = fixture.plan.inventory.units[0]!;
  const staged = stagedPath(fixture.dir, 1, unit.relPath);
  await plant(fixture.root, staged, "staged bytes");
  const units = [{ ...unit, sha256: options.unitSha ?? unit.sha256, staged: await identityAt(fixture.root, staged) }];
  const priors = fixture.plan.inventory.priors.map((prior, at) => ({ relPath: prior.relPath, sha256: prior.sha256, identity: at === 0 ? options.priorIdentity ?? null : null }));
  await plantLeaf(fixture.root, path.posix.join(fixture.dir, "attempt-1", "stage.json"), { format: "llmwiki-scale-downgrade-stage", version: 1, plan: fixture.plan.digest, attempt: 1, units, priors });
}

describe("an absent prior", () => {
  it("is accepted while absent, and refused once a file is there", async () => {
    const fixture = await proving({ sha256: null, bytes: 0 });
    const proof = await proveNoMove(fixture.root, fixture.dir, fixture.plan, []);
    expect(proof.priors[0]).toEqual({ relPath: fixture.priorRel, sha256: null, identity: null });
    expect(proof.manifest).toBeNull();
    await plant(fixture.root, fixture.priorRel, PRIOR_TEXT);
    expect(await refusalOf(fixture)).toBe(p5(`${fixture.priorRel} should be absent, as the plan found it`));
  });
});

describe("a present prior", () => {
  it("is accepted with its observed identity when its digest and size match", async () => {
    const fixture = await presentPrior();
    await plant(fixture.root, fixture.priorRel, PRIOR_TEXT);
    const proof = await proveNoMove(fixture.root, fixture.dir, fixture.plan, []);
    const [first] = proof.priors;
    expect([first?.relPath, first?.sha256]).toEqual([fixture.priorRel, sha256(PRIOR_TEXT)]);
    const observed = await identityAt(fixture.root, fixture.priorRel);
    expect(first?.identity != null && observed !== null && sameObject(first.identity, observed)).toBe(true);
  });

  it("is refused with another digest at the same size", async () => {
    const fixture = await presentPrior();
    await plant(fixture.root, fixture.priorRel, "PRIOR");
    expect(await refusalOf(fixture)).toBe(p5(`${fixture.priorRel} is not the prior file the plan bound`));
  });

  it("is refused when only its size differs: the file's digest is the plan's, its recorded byte count is not", async () => {
    const fixture = await proving({ sha256: sha256(PRIOR_TEXT), bytes: Buffer.byteLength(PRIOR_TEXT) + 1 });
    await plant(fixture.root, fixture.priorRel, PRIOR_TEXT);
    expect(await refusalOf(fixture)).toBe(p5(`${fixture.priorRel} is not the prior file the plan bound`));
  });
});

describe("a complete stage manifest", () => {
  it("is accepted when it binds the plan's units and priors", async () => {
    const fixture = await proving({ sha256: null, bytes: 0 });
    await stageComplete(fixture);
    const proof = await proveNoMove(fixture.root, fixture.dir, fixture.plan, []);
    expect(proof.manifest?.attempt).toBe(1);
  });

  it("is refused when its units are not the plan's", async () => {
    const fixture = await proving({ sha256: null, bytes: 0 });
    await stageComplete(fixture, { unitSha: "b".repeat(64) });
    const prefix = `scale_downgrade_not_cancellable: P7: ${fixture.dir}/attempt-1/stage.json: `;
    expect(await refusalOf(fixture)).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*the stage manifest does not bind this plan's units and prior files`, "u"));
  });

  it("binds a present prior's identity: accepted as bound, refused once the same bytes sit at a different inode", async () => {
    const fixture = await presentPrior();
    await plant(fixture.root, fixture.priorRel, PRIOR_TEXT);
    await stageComplete(fixture, { priorIdentity: await identityAt(fixture.root, fixture.priorRel) });
    expect(await refusalOf(fixture)).toBe("accepted");
    // The bound inode stays alive at a retained path, so the replacement cannot reuse it.
    await rename(path.join(fixture.root, fixture.priorRel), path.join(fixture.root, "retained-prior"));
    await plant(fixture.root, fixture.priorRel, PRIOR_TEXT);
    expect(await refusalOf(fixture)).toBe(p5(`${fixture.priorRel} is not the object the stage manifest bound`));
  });
});
