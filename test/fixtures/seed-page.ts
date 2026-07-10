/**
 * @file test/fixtures/seed-page.ts
 * @description The `SeedPage` shape and its writer, shared by every
 * non-default profile fixture (`research-profile.ts` via `research-seeds.ts`,
 * `newsroom-profile.ts`). Each profile fixture owns its own seed DATA — only
 * the write mechanics (frontmatter + body -> markdown file under the entity's
 * directory) are common, so this module carries no profile-specific content.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** One seed page: its entity directory, slug, frontmatter block, and markdown body. */
export interface SeedPage {
  directory: string;
  slug: string;
  frontmatter: string;
  body: string;
}

/**
 * Write one seed page (frontmatter + body) under its entity directory.
 *
 * @param root - Absolute project root directory.
 * @param page - The page to materialize.
 */
export async function writeSeedPage(root: string, page: SeedPage): Promise<void> {
  await mkdir(path.join(root, page.directory), { recursive: true });
  const contents = `---\n${page.frontmatter}\n---\n\n${page.body}\n`;
  await writeFile(path.join(root, page.directory, `${page.slug}.md`), contents, "utf8");
}
