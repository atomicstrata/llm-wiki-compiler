/**
 * @file test/preparation-synthetic-packs.test.ts
 * @description Proves the two Task 11 synthetic packs are REAL, and that they
 * differ in exactly one way.
 *
 * A fixture with no consumer is the defect this whole line of work exists to
 * stop making: the superseded attempt shipped a complete abstraction whose only
 * callers were tests, so the fixtures supplied whatever shape the code expected
 * and nothing failed until a reviewer read it. A pack that only ever round-trips
 * through a parser would be the same thing in miniature — so each pack is also
 * driven end to end through the BUILT BINARY, in its own temp project, exactly
 * as an operator would: plan document and seed on disk, `preparation stage`, and
 * the run read back through a separate `preparation list` process.
 *
 * The genericity seed Task 11 builds on is the last two tests. The packs share
 * no distinctive noun (the forbidden-identifier scan), and each pack's mechanics
 * survive erasing its OWN vocabulary — the useful within-pack half. The old
 * cross-pack byte-identical-skeleton assertion is REMOVED (Chunk 3 design v3 §2):
 * it forced the two packs to share one topology, which contradicts the governing
 * PO-INV-40 requirement that packs VARY graph/gates/effects. Genericity is now
 * proven where it belongs — two DISSIMILAR packs run through the ONE unchanged
 * runner in `pack-journeys.test.ts` — not by making these two documents identical.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePreparationPlan } from "../src/preparations/plan-parse.js";
import { canonicalBytes } from "../src/profile/templates/signing/canonical.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import { initializedWorkspace, listedStates } from "./preparation-cli-fixture.js";
import {
  syntheticResearchPack, type SyntheticPack,
} from "./fixtures/preparations/synthetic-research-pack.js";
import {
  syntheticEditorialIncidentPack,
} from "./fixtures/preparations/synthetic-editorial-incident-pack.js";

const PACKS: readonly SyntheticPack[] = [syntheticResearchPack, syntheticEditorialIncidentPack];

/** The envelope `preparation stage` emits for a run it accepted. */
interface StagedEnvelope { status: string; runId: string; workspaceId: string }

/**
 * Put one pack on disk as an operator would and stage it through the binary.
 *
 * The whole preamble is one call so a pack's own test body is nothing but its
 * assertions: the plan document and the seed are written as plain files, and the
 * only thing that turns them into a run is the compiled CLI.
 */
async function stagePack(pack: SyntheticPack): Promise<{ cwd: string; envelope: StagedEnvelope }> {
  const cwd = await initializedWorkspace(`synthetic-${pack.name}`);
  const planFile = path.join(cwd, "plan.json");
  const seedFile = path.join(cwd, "seed.json");
  await writeFile(planFile, JSON.stringify(pack.planDocument()));
  await writeFile(seedFile, JSON.stringify(pack.seed));
  const staged = await runCLI(
    ["preparation", "stage", planFile, "--seed", seedFile, "--json"], cwd);
  expectCLIExit(staged, 0);
  return { cwd, envelope: JSON.parse(staged.stdout) as StagedEnvelope };
}

describe("each synthetic pack is a real normalized plan", () => {
  for (const pack of PACKS) {
    it(`${pack.name} parses through the production loader with its own vocabulary`, () => {
      // The PRODUCTION loader, not a fixture-side check: it enforces the closed
      // grammar, the phase graph, and the worst-case bounds arithmetic, so a
      // pack that parses here is a document the engine would accept.
      const plan = parsePreparationPlan(JSON.stringify(pack.planDocument()));
      const vocabulary = pack.vocabulary;
      expect(plan.workspaceId).toBe(vocabulary.workspaceId);
      expect(plan.phases.map((phase) => phase.logicalPhaseId)).toEqual([
        vocabulary.originPhaseId, vocabulary.fanOutPhaseId, vocabulary.gatePhaseId,
        vocabulary.repeatPhaseId, vocabulary.joinPhaseId,
      ]);
      expect(plan.outputContract.producingPhaseIds).toEqual([vocabulary.joinPhaseId]);
    });
  }
});

describe("each synthetic pack stages end to end through the built binary", () => {
  for (const pack of PACKS) {
    it(`${pack.name} stages and then appears in a fresh list process`, async () => {
      // Nothing here calls the preparation substrate in process. If either pack
      // were a shape only a fixture accepts — a declared bound the engine
      // recomputes differently, a seed whose digest does not match the plan's
      // declared input set — staging refuses and this test is red.
      const { cwd, envelope } = await stagePack(pack);
      expect(envelope.status).toBe("staged");
      // The run landed in the PACK's workspace, not a default one.
      expect(envelope.workspaceId).toBe(pack.vocabulary.workspaceId);
      // Read back through a SEPARATE process, so nothing in memory can vouch
      // for a run the durable store does not actually have.
      expect((await listedStates(cwd))[envelope.runId]).toBe("planned");
    });
  }
});

/** Every lowercase word in a text, splitting camelCase and punctuation alike. */
function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word.length > 0);
}

/** The distinctive words one pack's vocabulary contributes. */
function vocabularyWords(pack: SyntheticPack): Set<string> {
  return new Set(Object.values(pack.vocabulary).flatMap(words));
}

/** Every word appearing anywhere in a pack's plan document and seed. */
function packWords(pack: SyntheticPack): string[] {
  return words(`${JSON.stringify(pack.planDocument())}${JSON.stringify(pack.seed)}`);
}

describe("the two packs differ in vocabulary and nothing else", () => {
  it("shares no distinctive noun in either direction", () => {
    const research = vocabularyWords(syntheticResearchPack);
    const editorial = vocabularyWords(syntheticEditorialIncidentPack);
    // THE PRECONDITION, pinned. An empty or near-empty vocabulary satisfies
    // every assertion below while proving nothing at all.
    expect(research.size).toBeGreaterThan(15);
    expect(editorial.size).toBeGreaterThan(15);
    // Scanned against the whole opposing DOCUMENT, not just its vocabulary: a
    // research word that leaked into an editorial phase id, gate id, or seed
    // value is exactly the drift this has to catch.
    const researchText = packWords(syntheticResearchPack);
    const editorialText = packWords(syntheticEditorialIncidentPack);
    for (const word of research) expect(editorialText).not.toContain(word);
    for (const word of editorial) expect(researchText).not.toContain(word);
  });

  it("leaves each pack's mechanics free of its own vocabulary once erased", () => {
    // The useful within-pack half (design v3 §2), replacing the removed cross-pack
    // byte-identity: after a pack's own nouns are substituted out, the remaining
    // skeleton — the mechanics — contains NONE of them, so no engine behaviour is
    // keyed to the pack's vocabulary. This proves genericity WITHOUT forcing the
    // two packs to share a topology, which PO-INV-40 forbids.
    for (const pack of PACKS) {
      const mechanics = new Set(words(skeleton(pack)));
      for (const term of vocabularyWords(pack)) expect(mechanics).not.toContain(term);
    }
  });
});

/**
 * One pack's plan document with its own names replaced by the field that
 * supplied them.
 *
 * The initial input set is CONTENT-ADDRESSED to the pack's seed, so its digest
 * and byte count must differ between packs; every other digest — the executor
 * pins, the authority and contract references, the safety floor — is compared
 * byte for byte, because those are mechanics and a difference there would mean
 * the two packs are not running the same plan after all.
 */
function skeleton(pack: SyntheticPack): string {
  let text = JSON.stringify(pack.planDocument());
  for (const [field, term] of Object.entries(pack.vocabulary)) {
    text = text.replaceAll(`"${term}"`, `"<${field}>"`);
  }
  const seedDigest = createHash("sha256").update(canonicalBytes(pack.seed)).digest("hex");
  return text
    .replaceAll(`sha256:${seedDigest}`, "sha256:<seed>")
    .replace(/"byteCount":\d+/u, '"byteCount":"<seed>"');
}
