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
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import type { ProfilePack, EntityPageView } from "../../src/profile/types.js";

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
 * Seed a `SAMPLE_PROFILE` project with `count` valid `notes` pages named
 * `note-00`, `note-01`, … so the additive entity section has more pages than a
 * small `limit`. Zero-padded so lexical `id` order is stable and predictable.
 *
 * @param root - Absolute project root directory.
 * @param count - How many `notes` pages to seed.
 */
export async function seedManyNotesProject(root: string, count: number): Promise<void> {
  await writeProfileFile(root, SAMPLE_PROFILE);
  for (let i = 0; i < count; i++) {
    const slug = `note-${String(i).padStart(2, "0")}`;
    await writeMarkdownPage(root, "wiki/notes", slug, `---\ntitle: Note ${i}\n---\nBody ${i}.`);
  }
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
