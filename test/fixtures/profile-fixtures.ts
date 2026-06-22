/**
 * @file test/fixtures/profile-fixtures.ts
 * @description Reusable NON-DEFAULT profile project fixtures for read-only
 * profile substrate and CLI tests.
 *
 * `buildResearchLiteProject` writes a `.llmwiki/profile.json` describing a
 * small research wiki — `papers`, `ideas`, `experiments` — each under `wiki/`,
 * with simple required/enum fields and an `ideas` lifecycle
 * (`proposed → testing → tested → {validated, failed}`). It then seeds a couple
 * of slug-safe pages per directory via raw `fs` so collectors and status have
 * real entity pages to find.
 *
 * The fixture is intentionally pure data + filesystem writes: it touches NO
 * `src/` profile internals, so it exercises the same authoring path a real
 * user would.
 *
 * Re-exports: `appendRelation` and `readRelations` are re-exported so the
 * relation-contract test files can import shared helpers + store functions from
 * one import line, keeping their import blocks structurally distinct.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import type { EntityId, ProfilePack, EntityPageView } from "../../src/profile/types.js";
import { appendRelation, updateRelation, compactRelations } from "../../src/relations/store.js";
import { readRelations } from "../../src/relations/store-read.js";

export { appendRelation, updateRelation, compactRelations } from "../../src/relations/store.js";
export { readRelations } from "../../src/relations/store-read.js";

/**
 * A minimal NON-DEFAULT profile: a single `notes` entity type at `wiki/notes`
 * requiring a `title` field. Shared by the additive read-surface tests
 * (listPages / export / viewer) so they assert against one fixed shape.
 */
export const SAMPLE_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "sample",
  entities: {
    notes: {
      directory: "wiki/notes",
      requiredFields: ["title"],
      fields: { title: { type: "string" } },
    },
  },
};

/** Stock `experiments` endpoint EntityId for the in-memory relation fixtures. */
export const EXPERIMENT_A = "experiments/a" as EntityId;
/** Stock `ideas` endpoint EntityId for the in-memory relation fixtures. */
export const IDEA_B = "ideas/b" as EntityId;

/**
 * Build an in-memory NON-DEFAULT profile with `experiments` + `ideas` entity
 * types and a caller-supplied `relations` block. Shared by the relation
 * write-path / contract / confinement tests so they declare ONE entity shape and
 * vary only the relation definitions under test.
 *
 * @param relations - The `relations` block to attach.
 * @returns A complete {@link ProfilePack}.
 */
export function experimentsIdeasProfile(relations: ProfilePack["relations"]): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
    relations,
  };
}

/** Write a profile.json into the project's `.llmwiki/` dir. */
export async function writeProfileFile(root: string, pack: ProfilePack): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack));
}

/** Write a markdown page at `<root>/<dir>/<slug>.md`, creating the dir. */
export async function writeMarkdownPage(
  root: string,
  dir: string,
  slug: string,
  content: string,
): Promise<void> {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, dir, `${slug}.md`), content);
}

/**
 * Seed a `SAMPLE_PROFILE` project with one valid `notes` page (`first-note`,
 * body "Note body.") — the shared baseline the additive read-surface tests use
 * before adding their own contract-violation cases.
 */
export async function seedSampleNotesProject(root: string): Promise<void> {
  await writeProfileFile(root, SAMPLE_PROFILE);
  await writeMarkdownPage(root, "wiki/notes", "first-note", "---\ntitle: First\n---\nNote body.");
}

/**
 * Assert an entity-page VIEW is the seeded `first-note` from
 * {@link seedSampleNotesProject}: the `notes` type, `first-note` slug, the full
 * "Note body." body (so a body-stripping bug would fail this), a
 * project-relative `path`, and NO leaked absolute `filePath`.
 */
export function expectFirstNotePage(page: EntityPageView): void {
  expect(page.entityType).toBe("notes");
  expect(page.slug).toBe("first-note");
  expect(page.body).toBe("Note body.");
  expect(page.path).toBe("wiki/notes/first-note.md");
  expect("filePath" in page).toBe(false);
}

/**
 * Seed a `SAMPLE_PROFILE` project with `count` `notes` pages whose slug is
 * `<prefix>-NN` (zero-padded so lexical `id` order is stable), each built from
 * `content(slug, i)`. The shared loop behind both the valid and broken seeders
 * so their paging/bounding setup never drifts.
 */
async function seedNotesProject(
  root: string,
  count: number,
  prefix: string,
  content: (slug: string, index: number) => string,
): Promise<void> {
  await writeProfileFile(root, SAMPLE_PROFILE);
  for (let i = 0; i < count; i++) {
    const slug = `${prefix}-${String(i).padStart(2, "0")}`;
    await writeMarkdownPage(root, "wiki/notes", slug, content(slug, i));
  }
}

/**
 * Seed a `SAMPLE_PROFILE` project with `count` VALID `notes` pages named
 * `note-00`, `note-01`, … so the additive entity section has more pages than a
 * small `limit`.
 *
 * @param root - Absolute project root directory.
 * @param count - How many `notes` pages to seed.
 */
export async function seedManyNotesProject(root: string, count: number): Promise<void> {
  await seedNotesProject(root, count, "note", (_slug, i) => `---\ntitle: Note ${i}\n---\nBody ${i}.`);
}

/**
 * Seed a `SAMPLE_PROFILE` project with `count` INVALID `notes` pages, each
 * missing the required `title` field so every page yields exactly one
 * `field-violation` problem (`broken-00`, …). Used to exercise per-surface
 * problem bounding (windowing / capping).
 *
 * @param root - Absolute project root directory.
 * @param count - How many broken `notes` pages to seed.
 */
export async function seedBrokenNotesProject(root: string, count: number): Promise<void> {
  await seedNotesProject(root, count, "broken", (slug, i) => `---\nslug: ${slug}\n---\nNo title ${i}.`);
}

/**
 * The research-lite profile pack written to `.llmwiki/profile.json`. Three
 * entity types under `wiki/`; `ideas` carries a lifecycle FSM whose enum field
 * values exactly equal its state set (required by the validator).
 */
export const RESEARCH_LITE_PROFILE = {
  schemaVersion: 1,
  profileId: "research-lite",
  displayName: "Research Lite",
  entities: {
    papers: {
      directory: "wiki/papers",
      requiredFields: ["title"],
      fields: { title: { type: "string" }, venue: { type: "string" } },
    },
    ideas: {
      directory: "wiki/ideas",
      requiredFields: ["status"],
      fields: {
        status: {
          type: "enum",
          enum: ["proposed", "testing", "tested", "validated", "failed"],
        },
        // Declared so the `failed` state can require it as transition evidence:
        // the profile validator now demands every transitionRequirements field be
        // a declared entity field (FIX 2). Extending fixtures attach
        // `transitionRequirements: { failed: ["failureReason"] }`.
        failureReason: { type: "string" },
      },
      lifecycle: {
        field: "status",
        initial: "proposed",
        terminal: ["validated", "failed"],
        transitions: {
          proposed: ["testing"],
          testing: ["tested"],
          tested: ["validated", "failed"],
        },
      },
    },
    experiments: {
      directory: "wiki/experiments",
      fields: { runtime: { type: "string" } },
    },
  },
} as const;

/**
 * A research-lite profile EXTENDED with a `tests` relation type
 * (`experiments → ideas`, directed, optional `metric` attribute). Kept separate
 * from {@link RESEARCH_LITE_PROFILE} so the base fixture stays relation-LESS for
 * tests that trim its entity set (a relation referencing a trimmed-away entity
 * type would fail profile validation). Materialized via
 * {@link buildResearchLiteRelationsProject} + {@link seedTestsRelation}.
 */
export const RESEARCH_LITE_RELATIONS_PROFILE = {
  ...RESEARCH_LITE_PROFILE,
  relations: {
    tests: {
      from: ["experiments"],
      to: ["ideas"],
      direction: "directed",
      attributes: { metric: { type: "string" } },
    },
  },
} as const;

/** One slug-safe seed page per entity directory, keyed by repo-relative dir. */
const SEED_PAGES: Record<string, string[]> = {
  "wiki/papers": ["attention-is-all-you-need", "scaling-laws"],
  "wiki/ideas": ["sparse-routing", "curriculum-pretraining"],
  "wiki/experiments": ["ablation-batch-size"],
};

/**
 * Frontmatter satisfying each entity type's declared required-field contract,
 * so the seeded pages collect cleanly (no `field-violation` problems): `papers`
 * requires `title`, `ideas` requires `status` (a valid lifecycle state).
 */
const SEED_FRONTMATTER: Record<string, string> = {
  "wiki/papers": "title: Seed Paper",
  "wiki/ideas": "status: proposed",
};

/** Write a contract-satisfying slug-safe markdown page (no frontmatter slug). */
async function writeSeedPage(root: string, dir: string, slug: string): Promise<void> {
  const fields = SEED_FRONTMATTER[dir];
  const fm = fields ? `---\n${fields}\n---\n\n` : "";
  await writeFile(path.join(root, dir, `${slug}.md`), `${fm}# ${slug}\n`, "utf8");
}

/**
 * Materialize a research-lite NON-DEFAULT project at `root`: write the profile
 * file and seed a couple of slug-safe pages per entity directory.
 *
 * @param root - Absolute project root directory (must already exist).
 */
export async function buildResearchLiteProject(root: string): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(root, ".llmwiki", "profile.json"),
    `${JSON.stringify(RESEARCH_LITE_PROFILE, null, 2)}\n`,
    "utf8",
  );
  for (const [dir, slugs] of Object.entries(SEED_PAGES)) {
    await mkdir(path.join(root, dir), { recursive: true });
    for (const slug of slugs) await writeSeedPage(root, dir, slug);
  }
}

/**
 * Materialize a research-lite project whose on-disk profile DECLARES the `tests`
 * relation type ({@link RESEARCH_LITE_RELATIONS_PROFILE}). Builds the base
 * project (entity dirs + seed pages), then overwrites the profile file so the
 * read surfaces (status/export/lint) see the relations block.
 *
 * @param root - Absolute project root directory (must already exist).
 */
export async function buildResearchLiteRelationsProject(root: string): Promise<void> {
  await buildResearchLiteProject(root);
  await writeFile(
    path.join(root, ".llmwiki", "profile.json"),
    `${JSON.stringify(RESEARCH_LITE_RELATIONS_PROFILE, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Append a `tests` relation (`experiments/<from>` → `ideas/<to>`) into a
 * research-lite project's relation store, returning its minted ref. Used by the
 * relation-lint/surfacing tests to seed both HEALTHY (both endpoints have seed
 * pages) and DANGLING (a missing endpoint slug) relations.
 *
 * @param root - Absolute project root (must already be a research-lite project).
 * @param fromSlug - The `experiments` endpoint slug.
 * @param toSlug - The `ideas` endpoint slug.
 * @returns The persisted relation reference.
 */
export async function seedTestsRelation(
  root: string,
  fromSlug: string,
  toSlug: string,
): Promise<{ id: string; type: string }> {
  return appendRelation(root, RESEARCH_LITE_RELATIONS_PROFILE as ProfilePack, {
    type: "tests",
    from: `experiments/${fromSlug}` as EntityId,
    to: `ideas/${toSlug}` as EntityId,
    attributes: { metric: "f1" },
  });
}

/**
 * Factory that returns a `write` helper bound to the caller's mutable `root`
 * and profile. Shared by the relation-attribute-contract and
 * relation-required-undefined test files so they don't each define the same
 * `write = (attributes) => appendRelation(root, profile(), {...})` closure.
 *
 * @param getRoot - Returns the current test `root` (closure over mutable variable).
 * @param getProfile - Returns the profile under test.
 */
export function makeRelationWriter(
  getRoot: () => string,
  getProfile: () => ProfilePack,
): (attributes: Record<string, unknown>) => Promise<{ id: string; type: string }> {
  return (attributes) =>
    appendRelation(getRoot(), getProfile(), { type: "tests", from: EXPERIMENT_A, to: IDEA_B, attributes });
}

/**
 * Seed a 3-version compaction scenario: append `{a:"1"}`, update to `{a:"2"}`,
 * update to `{a:"3"}`. Returns the relation id for callers that call
 * `compactRelations` themselves. Shared by the compaction-confine and
 * store-audit tests to avoid repeating the 3-step append+update sequence.
 *
 * @param root - Project root.
 * @param profile - Profile declaring the `tests` relation.
 * @returns The relation id of the seeded record.
 */
export async function seedThreeVersionRelation(root: string, profile: ProfilePack): Promise<string> {
  const ref = await appendRelation(root, profile, { type: "tests", from: EXPERIMENT_A, to: IDEA_B, attributes: { a: "1" } });
  await updateRelation(root, profile, ref.id, { attributes: { a: "2" } });
  await updateRelation(root, profile, ref.id, { attributes: { a: "3" } });
  return ref.id;
}

/**
 * Assert that a just-compacted store shrank and the sole surviving record has
 * `{a:"3"}`. Shared by the compaction-confine and store-audit tests so they
 * don't each repeat the same readRelations + expect block.
 *
 * @param root - Project root.
 * @param result - The `{before, after}` result from `compactRelations`.
 */
export async function assertCompactionShrankTo3(
  root: string,
  result: { before: number; after: number },
): Promise<void> {
  expect(result.after).toBeLessThan(result.before);
  const { relations } = await readRelations(root);
  expect(relations).toHaveLength(1);
  expect(relations[0].attributes).toEqual({ a: "3" });
}
