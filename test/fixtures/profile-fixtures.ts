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

/** Write a minimal slug-safe markdown page (no frontmatter slug) under `dir`. */
async function writeSeedPage(root: string, dir: string, slug: string): Promise<void> {
  await writeFile(path.join(root, dir, `${slug}.md`), `# ${slug}\n`, "utf8");
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
