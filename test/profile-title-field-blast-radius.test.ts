/**
 * @file test/profile-title-field-blast-radius.test.ts
 * @description `EntityTypeDef.titleField` changed the meaning of
 * `EntityPage.title`, which several surfaces already consumed. These pin the two
 * that must NOT follow it.
 *
 * The field went from "the literal `title` frontmatter key" to "whatever key the
 * type declares". Two consumers were written against the old meaning and are
 * wrong under the new one:
 *
 *  - `src/profile/lint.ts` feeds it to `empty-page`, a rule that asks whether a
 *    page ANNOUNCING a title has prose beneath it. Under the new meaning every
 *    frontmatter-only record type — the normal shape for `desks`, `people`,
 *    `bylines` — starts announcing one, so adopting a shipped template would
 *    turn a clean project's lint and health score red.
 *  - `src/export/okf/profile-docs.ts` writes it into OKF frontmatter, a
 *    published interchange format. Under the new meaning a `desks` record gains
 *    a `title` key it never had while `collectDomainFields` keeps exporting
 *    `name`, shipping one value under two keys.
 *
 * Both now read the literal frontmatter key. The RESOLVED title is still used
 * where a display title is what is wanted (the viewer, the graph, the OKF TOC).
 */

import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { lintProfileEntities } from "../src/profile/lint.js";
import { collectProfileEntityDocs } from "../src/export/okf/profile-docs.js";
import { collectEntityPages } from "../src/profile/collect.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeMarkdownPage, writeProfileFile } from "./fixtures/profile-fixtures.js";
import { NEWSROOM_TEMPLATE } from "../src/profile/templates/builtin/newsroom.js";
import type { ProfilePack } from "../src/profile/types.js";

/** The shipped newsroom profile — `desks` titles by `name`, and declares no `title` field. */
const PROFILE: ProfilePack = NEWSROOM_TEMPLATE.profile;

/** A frontmatter-only desk: fields, no prose. The normal shape for a reference record. */
const FRONTMATTER_ONLY = "---\nname: Tech Desk\nstage: active\n---\n";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

/** Seed a newsroom project holding one desk with the given file body. */
async function seed(content: string): Promise<string> {
  const root = await makeTempRoot("title-blast-radius");
  roots.push(root);
  await writeProfileFile(root, PROFILE);
  await writeMarkdownPage(root, "wiki/desks", "tech", content);
  return root;
}

describe("the empty-page rule judges the announced title, not the display title", () => {
  it("does not flag a frontmatter-only record whose type titles by another key", async () => {
    const findings = await lintProfileEntities(await seed(FRONTMATTER_ONLY), PROFILE);
    expect(findings.map((finding) => finding.rule)).not.toContain("empty-page");
  });

  it("still flags a record that literally announces a title and has no prose", async () => {
    const root = await seed("---\nname: Tech Desk\nstage: active\ntitle: Tech Desk\n---\n");
    const findings = await lintProfileEntities(root, PROFILE);
    expect(findings.map((finding) => finding.rule)).toContain("empty-page");
  });

  it("does not flag a record that has real prose either way", async () => {
    const body = "Covers technology, platforms, and the companies behind them in depth.";
    const root = await seed(`---\nname: Tech Desk\nstage: active\ntitle: Tech Desk\n---\n\n${body}`);
    const findings = await lintProfileEntities(root, PROFILE);
    expect(findings.map((finding) => finding.rule)).not.toContain("empty-page");
  });
});

/** The rendered OKF document for the seeded desk. */
async function okfDoc(content: string) {
  const docs = await collectProfileEntityDocs(await seed(content), () => null as never, {
    profile: PROFILE,
  } as never);
  return docs[0];
}

describe("OKF export carries the title the page wrote, not the one the type resolves", () => {
  it("adds no title key for a record whose type titles by another field", async () => {
    const doc = await okfDoc(FRONTMATTER_ONLY);
    expect(doc.content).not.toMatch(/^title:/m);
  });

  it("still exports the title-bearing field once, as a domain field", async () => {
    const doc = await okfDoc(FRONTMATTER_ONLY);
    expect(doc.content.match(/^name: Tech Desk$/gm)).toHaveLength(1);
  });

  it("still carries a literal title when the page writes one", async () => {
    const doc = await okfDoc("---\nname: Tech Desk\nstage: active\ntitle: The Desk\n---\n");
    expect(doc.content).toMatch(/^title: The Desk$/m);
  });

  // The TOC entry is a DISPLAY title, so it does follow the declaration — that
  // is the half of the change worth keeping.
  it("still uses the resolved title for the bundle's table of contents", async () => {
    const doc = await okfDoc(FRONTMATTER_ONLY);
    expect(doc.title).toBe("Tech Desk");
  });
});

describe("the collector itself still resolves the declared title", () => {
  it("keeps the resolution the viewer and graph read", async () => {
    const { pages } = await collectEntityPages(await seed(FRONTMATTER_ONLY), PROFILE);
    expect(pages[0]?.title).toBe("Tech Desk");
  });
});
