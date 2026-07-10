/**
 * @file test/fixtures/newsroom-profile.ts
 * @description The SECOND non-default profile — a deliberately dissimilar `newsroom`
 * wiki — used to prove the CLP machinery is not research-shaped (Phase-7 C1). It
 * declares three unrelated entity types (`articles`, `desks`, `bylines`), each with a
 * field contract and a lifecycle FSM over a required enum, and one typed relation
 * (`filed-under`: an article filed under a desk). Pure data + filesystem writes,
 * backed by the shipped newsroom template data so the proof fixture cannot drift.
 *
 * It ALSO declares a minimal `story-pipeline` workflow (draft an article, then file
 * it under a desk under an `agent:edited` gate) and a `story.file` submit action —
 * the Phase-7 C1 genericity proof. `test/newsroom-workflow-e2e-cli.test.ts` EXECUTES
 * every write/authority leg over this vocabulary through the SAME src/ with zero
 * newsroom-specific code: the page-submit apply, the `filed-under` relation-submit
 * apply (and its endpoint-type scope guard), the `agent:edited` gate approval, and
 * the `story.file` submit-action dispatch — so the C1 gate is airtight for those
 * legs, not merely inferred from the run-lifecycle start/advance/park.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { appendRelation } from "../../src/relations/store.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import { newsroomEntities, newsroomRelations, newsroomWorkflowActions, newsroomWorkflows } from "../../src/profile/templates/builtin/newsroom.js";
import { writeSeedPage, type SeedPage } from "./seed-page.js";

/** The `newsroom` profile pack — no vocabulary shared with the research pack. */
export const NEWSROOM_PROFILE: ProfilePack = {
  schemaVersion: 1, profileId: "newsroom", profileVersion: "0.1.0", displayName: "Newsroom",
  entities: newsroomEntities,
  relations: newsroomRelations,
  connectors: {
    fixture: {
      entityType: "articles",
      fields: { headline: "headline", stage: "stage" },
      contentField: "body",
    },
  },
  workflows: newsroomWorkflows,
  workflowActions: newsroomWorkflowActions,
};

/** Declared entity + relation types, so tests assert presence without re-spelling. */
export const NEWSROOM_ENTITY_TYPES = ["articles", "desks", "bylines"] as const;
export const NEWSROOM_RELATION_TYPES = ["filed-under"] as const;

const SEED_PAGES: SeedPage[] = [
  { directory: "wiki/articles", slug: "port-strike-latest",
    frontmatter: "headline: Port Strike Enters Second Week\nstage: published",
    body: "Dockworkers at the eastern port entered a second week of industrial action on Tuesday." },
  { directory: "wiki/desks", slug: "metro",
    frontmatter: "name: Metro Desk\nstage: active",
    body: "The metro desk covers city government, transit, and local labor disputes." },
  { directory: "wiki/bylines", slug: "j-rivera",
    frontmatter: "reporter: J. Rivera\nstage: confirmed",
    body: "A staff reporter on the metro desk covering the waterfront and municipal labor beats." },
];

/** Write the newsroom profile file (profile only, no seed pages). */
export async function installNewsroomProfile(root: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(NEWSROOM_PROFILE, null, 2)}\n`, "utf8");
}

/** Materialize a newsroom project at `root`: the profile file + every seed page. */
export async function buildNewsroomProject(root: string): Promise<void> {
  await installNewsroomProfile(root);
  for (const page of SEED_PAGES) await writeSeedPage(root, page);
}

/** Seed the single `filed-under` relation between backing pages (no dangling endpoint). */
export async function seedNewsroomRelations(root: string): Promise<void> {
  await appendRelation(root, NEWSROOM_PROFILE, {
    type: "filed-under",
    from: "articles/port-strike-latest" as EntityId,
    to: "desks/metro" as EntityId,
  });
}
