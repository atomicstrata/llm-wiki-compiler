/**
 * @file test/fixtures/research-profile.ts
 * @description The first REAL domain profile pack — a `research` wiki — plus the
 * helpers that materialize it as a test-fixture project (`.llmwiki/profile.json`
 * + typed pages) and seed its typed relations.
 *
 * The pack declares twelve entity types (`papers`, `sources`, `ideas`,
 * `experiments`, `manuscripts`, `topics`, `research-concepts`, `methods`,
 * `foundations`, `people`, `reviews`, `research-outputs`), each with a field
 * contract and a lifecycle FSM over a `stage` (or `verdict`) enum field, and
 * twelve typed relation types (`cites`, `builds-on`, `tests`, `challenges`,
 * `introduces-concept`, `uses-concept`, `proposes-method`, `extends-method`,
 * `supports`, `contradicts`, `derived-from`, `addresses-gap`) with multi-type
 * endpoint sets. Lifecycle transitions
 * carry both EVIDENCE-FIELD requirements and relation-count preconditions (G1):
 * an experiment reaches `complete` only with a `tests` relation to a
 * NON-REJECTED idea (`otherStates` filter), and a manuscript reaches `submitted`
 * only with a `cites`→paper relation.
 *
 * The pack ALSO declares executable `workflows` — a 4-stage `literature-review`
 * pipeline, a 9-stage `research` pipeline, a 4-stage `manuscript-writing`
 * pipeline, a 3-stage `experiment-design` pipeline (agent-gated), and a 3-stage
 * `review-response` pipeline (human-gated) — that drive the typed pages,
 * relations, and G1-gated lifecycle transitions end-to-end through the real CLI.
 * `literature-review` carries both a trust-gated PAGE stage (`gather-paper`) and
 * a trust-gated RELATION stage (`link-concept`), proving park-vs-refuse across
 * the two write kinds; `import-paper` is `research`'s sole `trust:`-gated stage;
 * the terminal transitions exercise the G1 seam.
 *
 * It ALSO declares five `workflowActions` — dotted shortcut ids resolving to a
 * workflow operation with declared per-surface `permissions`: `research.begin`
 * (start, trustGate), `research.check` (status, no gate needed), `research.step`
 * (advance, required `runId`), `literature.file-paper` (a PAGE `submit` shape),
 * and `review-response.approve` (a HUMAN gate — note the action id's first
 * segment is `review-response`, not `review`, since `review` is a reserved core
 * CLI verb; see `src/profile/reserved-verbs.ts`).
 *
 * It ALSO declares seven artifact TYPES (`experiment-result`, `paper-source-metadata`,
 * `experiment-plan`, `run-log`, `manuscript-draft`, `review-packet`,
 * `rebuttal-response`) — each a hash-pinned JSON or text leaf, some with a
 * partial metadata field contract. Only `experiment-result` is wired to a
 * field: the NON-required `result: artifactRef` on `experiments`, scoped to
 * that one type. The field is deliberately optional so every existing seeded
 * `experiments` page stays valid without pinning a ref — the artifact e2e
 * proof (`test/artifacts/e2e-research-artifact.test.ts`) authors its own pages
 * against this declaration. The other six types are TYPES ONLY in this slice —
 * no `artifactRef` field references them and no lifecycle declares an
 * artifact-existence precondition (trust rules + preconditions land in 7.3).
 *
 * This fixture is pure data + filesystem writes, backed by the shipped AutoSci
 * template data so the proof fixture cannot drift from the user-facing pack. The
 * seeded pages all satisfy their declared field contract and carry declared
 * lifecycle states + substantial bodies, so every read surface is clean.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { appendRelation } from "../../src/relations/store.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { autosciArtifacts } from "../../src/profile/templates/builtin/autosci/artifacts.js";
import { autosciEntities } from "../../src/profile/templates/builtin/autosci/entities.js";
import { autosciRelations } from "../../src/profile/templates/builtin/autosci/relations.js";
import { autosciWorkflowActions, autosciWorkflows } from "../../src/profile/templates/builtin/autosci/workflows.js";
import { SEED_PAGES, SEED_RELATIONS } from "./research-seeds.js";
import { writeSeedPage } from "./seed-page.js";

/**
 * The `research` profile pack. `profileId: "research"` is allowed (only
 * `default` is reserved). Every lifecycle `stage` enum's values EXACTLY equal
 * its lifecycle state set (required by the validator), and every
 * `transitionRequirements` evidence field is a declared, non-reserved field.
 * The `stage` field is REQUIRED on every entity type, so lifecycle enrollment
 * is mandatory — a page cannot opt out of its FSM by omitting the field (an
 * absent lifecycle field is otherwise exempt on create, `lifecycle.ts:150`).
 */
export const RESEARCH_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "research",
  profileVersion: "0.1.0",
  displayName: "Research",
  entities: autosciEntities,
  relations: autosciRelations,
  artifacts: autosciArtifacts,
  connectors: {
    crossref: {
      entityType: "papers",
      fields: { title: "title", doi: "doi", year: "year", authors: "authors", stage: "stage" },
      contentField: "abstract",
    },
  },
  workflows: autosciWorkflows,
  workflowActions: autosciWorkflowActions,
};

/** The declared workflow ids, so tests assert the set without re-spelling. */
export const RESEARCH_WORKFLOW_IDS = [
  "literature-review", "research", "experiment-design", "manuscript-writing", "review-response",
] as const;

/** The `literature-review` workflow's stage ids, in pipeline order, so tests
 * (including the Task 4 park-vs-refuse proofs on `gather-paper`/`link-concept`)
 * assert against them without re-spelling. */
export const LITERATURE_REVIEW_STAGES = [
  "gather-paper", "extract-concept", "link-concept", "synthesize-topic",
] as const;

/** The declared entity types, so tests assert per-type counts without re-spelling. */
export const RESEARCH_ENTITY_TYPES = [
  "papers", "sources", "ideas", "experiments", "manuscripts",
  "topics", "research-concepts", "methods", "foundations",
  "people", "reviews", "research-outputs",
] as const;

/**
 * Write the `research` profile pack into the project's `.llmwiki/` directory —
 * profile ONLY, no seed pages. The workflow E2E proofs use this so a run creates
 * every page it needs from scratch (no seeded page can mask a workflow write).
 *
 * @param root - Absolute project root directory.
 */
export async function installResearchProfile(root: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(RESEARCH_PROFILE, null, 2)}\n`, "utf8");
}

/**
 * Materialize a `research` NON-DEFAULT project at `root`: write the profile file
 * and seed every typed page. The project root must already exist.
 *
 * @param root - Absolute project root directory.
 */
export async function buildResearchProject(root: string): Promise<void> {
  await installResearchProfile(root);
  for (const page of SEED_PAGES) await writeSeedPage(root, page);
}

/** The relation types this fixture seeds, so tests assert presence without re-spelling. */
export const RESEARCH_RELATION_TYPES = [
  "cites", "builds-on", "tests", "challenges", "introduces-concept", "uses-concept",
  "proposes-method", "extends-method", "supports", "contradicts", "derived-from", "addresses-gap",
] as const;

/**
 * Append every {@link SEED_RELATIONS} typed relation into the project's relation
 * store. Every endpoint has a backing seed page, so no relation is dangling and
 * the read surfaces (status/export/lint/graph) stay clean.
 *
 * @param root - Absolute project root of a materialized research project.
 */
export async function seedResearchRelations(root: string): Promise<void> {
  for (const rel of SEED_RELATIONS) {
    await appendRelation(root, RESEARCH_PROFILE, { type: rel.type, from: rel.from, to: rel.to });
  }
}
