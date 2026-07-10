/**
 * @file test/no-research-branch-in-core.test.ts
 * @description CI BACKSTOP for the CLP Phase-6/7 invariant: a domain profile
 * must be PURE CONFIG — core `src/` must never special-case a domain profile's
 * vocabulary. This guard now covers BOTH shipped non-default profiles: `research`
 * (`papers`, `sources`, `manuscripts`, `cites`, `tests`, …) and `newsroom`
 * (`articles`, `desks`, `bylines`, `filed-under`) — a domain profile is data (a
 * `ProfilePack`), so its entity/relation names and its `profileId` may only ever
 * be READ generically, never branched on by literal.
 *
 * SCOPE — read this before trusting the guard. It is a cheap, NARROW tripwire, NOT
 * a semantic boundary. It scans every shipped `src/*.ts` (comments/strings
 * included — no AST) and fails on the one idiom it can cheaply catch: a strict OR
 * loose equality (`==`/`===`/`!=`/`!==`) whose other operand is a QUOTED vocabulary
 * literal (either operand order), plus `profileId == "research"` / `profileId ==
 * "newsroom"` and any `isResearch`/`isNewsroom` identifier. It does NOT catch
 * `switch (entityType){ case "papers": }`,
 * a membership test (`[...].includes` / `Set.has`), `.startsWith`/regex predicates,
 * a `const R = "research"` indirection, an object-key dispatch table, or a
 * template-literal operand — and it can FALSE-fire on the everyday words
 * `sources`/`tests`/`ideas` used unrelated to the profile. So it catches the naive
 * copy-paste leak and nothing subtler; the AUTHORITATIVE boundary is code review
 * plus the plan's manual grep (§6-C2), not this test.
 *
 * It scans ONLY `src/` on purpose: profile fixtures and tests (e.g.
 * `test/fixtures/research-profile.ts`) legitimately spell these names as data. The
 * suite lists offenders (file + matched snippet); green today because `src/`
 * carries no such literal branch.
 */

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** The domain vocabulary literals a core file must never string-compare against.
 * Covers entity + relation names, plus the shipped WORKFLOW ids and workflow-ACTION
 * ids (a core `workflowId === "literature-review"` or `actionId === "story.file"`
 * branch is as much a genericity leak as an entity-name branch). `concepts` is
 * deliberately EXCLUDED: core legitimately branches on the DEFAULT profile's
 * `wiki/concepts` page dir (unrelated to the research entity, which is keyed
 * `research-concepts`). The authoritative genericity boundary is the second-profile
 * fixture + code review, not this narrow tripwire. Also covers the 7 research
 * ARTIFACT-TYPE names (Slice 7.1's pack) — carried forward now that Slice 7.3 lands
 * enforcement code that resolves artifactRefs by type, so this PERSISTENT tripwire
 * stays coincident with the risk it guards, not just the one-shot Slice 7.3 grep. */
const VOCAB = "manuscripts|experiments|papers|ideas|sources|cites|builds-on|tests" +
  "|topics|research-concepts|methods|foundations|people|reviews|research-outputs" +
  "|challenges|introduces-concept|uses-concept|proposes-method|extends-method" +
  "|supports|contradicts|derived-from|addresses-gap" +
  "|articles|desks|bylines|filed-under" +
  // Workflow ids (both shipped profiles) and dotted workflow-action ids (dots escaped).
  "|research|literature-review|manuscript-writing|experiment-design|review-response|story-pipeline" +
  "|research\\.begin|research\\.check|research\\.step|literature\\.file-paper|review-response\\.approve|story\\.file" +
  // The 7 research artifact-type names (Slice 7.1 pack; now enforced by Slice 7.3).
  "|experiment-result|paper-source-metadata|experiment-plan|run-log|manuscript-draft|review-packet|rebuttal-response";

/** Equality operators a naive domain-branch would use — strict (`===`/`!==`) AND loose (`==`/`!=`). */
const EQ = "(===?|!==?)";

/** Domain-branch patterns: profileId special-case (either shipped profile), a
 * research/newsroom predicate, and equality against the vocabulary in BOTH operand orders. */
const FORBIDDEN: RegExp[] = [
  new RegExp(`profileId\\s*${EQ}\\s*["'](research|newsroom)["']`),
  /\bis(Research|Newsroom)\b/,
  new RegExp(`${EQ}\\s*["'](${VOCAB})["']`),
  new RegExp(`["'](${VOCAB})["']\\s*${EQ}`),
];

const TEMPLATE_DATA_FILES = new Set([
  `profile${path.sep}templates${path.sep}builtin${path.sep}default.ts`,
  `profile${path.sep}templates${path.sep}builtin${path.sep}autosci${path.sep}entities.ts`,
  `profile${path.sep}templates${path.sep}builtin${path.sep}autosci${path.sep}relations.ts`,
  `profile${path.sep}templates${path.sep}builtin${path.sep}autosci${path.sep}artifacts.ts`,
  `profile${path.sep}templates${path.sep}builtin${path.sep}autosci${path.sep}workflows.ts`,
  `profile${path.sep}templates${path.sep}builtin${path.sep}autosci.ts`,
  `profile${path.sep}templates${path.sep}builtin${path.sep}newsroom.ts`,
]);

function isTemplateDataFile(name: string): boolean {
  return TEMPLATE_DATA_FILES.has(name);
}

describe("no research domain-branch in core src/", () => {
  it("has zero core files that branch on the research vocabulary", async () => {
    const srcRoot = path.resolve("src");
    const names = await readdir(srcRoot, { recursive: true });
    const offenders: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".ts")) continue;
      if (isTemplateDataFile(name)) continue;
      const text = await readFile(path.join(srcRoot, name), "utf8");
      for (const pattern of FORBIDDEN) {
        const hit = pattern.exec(text);
        if (hit) offenders.push(`src/${name}: ${hit[0]}`);
      }
    }
    expect(offenders, `research domain-branch(es) found in core:\n${offenders.join("\n")}`).toEqual([]);
  });
});
