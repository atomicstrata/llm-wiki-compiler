/**
 * @file src/linter/fix-plan.ts
 * @description The fix PLAN behind AS-1 §4.6 `check`: which findings have a
 * deterministic repair, what that repair would change, and what the rest can
 * only be recommendations about.
 *
 * IT PROPOSES, IT NEVER WRITES. §4.6 pins that fixes are "previewed as a plan
 * and applied only through the ordinary reviewed mutation path", and that
 * `check` never writes knowledge directly. So this returns edits as data; no
 * function here touches a file.
 *
 * ONLY ONE FINDING CLASS IS DETERMINISTICALLY FIXABLE TODAY, and saying so is
 * the point. Most lint findings have no mechanical repair — nobody can derive
 * the right summary for a page that lacks one, or guess which page a broken
 * link meant. Inventing "fixes" for those would produce confident edits that are
 * wrong, which is worse than a recommendation. The one honest case is a
 * wikilink written as a page's TITLE when the page's filename differs: the
 * target is discoverable, and it is only proposed when EXACTLY ONE page carries
 * that title. Two candidates is ambiguity, and ambiguity is a recommendation.
 *
 * IT SHARES THE LINTER'S PRIMITIVES rather than parsing the linter's prose. A
 * finding's message is human text; keying a repair off it would break the first
 * time someone reworded a message. This walks the same pages with the same
 * pattern and the same slug function, so the two agree by construction — and a
 * control cross-checks that no fix is proposed where the linter saw no problem.
 */

import path from "node:path";
import { findMatchesInContent, collectAllPages, type PageScope } from "./rules-shared.js";
import { listLinkResolvablePendingSlugs } from "../compiler/candidates.js";
import { parseFrontmatter, slugify } from "../utils/markdown.js";

/** The wikilink form the linter scans for; shared so the two cannot diverge. */
const WIKILINK = /\[\[([^\]]+)\]\]/g;

/** One concrete, reviewable edit a deterministic fix would make. */
export interface LintFixEditV1 {
  readonly file: string;
  readonly line: number;
  readonly from: string;
  readonly to: string;
}

/** One planned repair, or an honest statement that none is derivable. */
export type LintFixPlanV1 =
  | { readonly kind: "fix"; readonly rule: string; readonly edit: LintFixEditV1 }
  | { readonly kind: "recommendation"; readonly rule: string; readonly file: string; readonly advice: string };

/** A page's title, when it declares one. */
function titleOf(content: string): string | undefined {
  const title = (parseFrontmatter(content).meta as { title?: unknown }).title;
  return typeof title === "string" && title.length > 0 ? title : undefined;
}

/** Slug → the pages whose TITLE reduces to it, so ambiguity stays visible. */
function pagesByTitleSlug(
  pages: readonly { filePath: string; content: string }[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const page of pages) {
    const title = titleOf(page.content);
    if (title === undefined) continue;
    const key = slugify(title);
    index.set(key, [...(index.get(key) ?? []), path.basename(page.filePath, ".md")]);
  }
  return index;
}

/**
 * Plan repairs for every broken wikilink in the wiki.
 *
 * @param root - Absolute project root.
 * @returns One entry per broken link: a concrete edit, or a recommendation.
 */
export async function planLintFixes(root: string, scope: PageScope = "wiki-wide"): Promise<LintFixPlanV1[]> {
  // Fix preview is an explicit new surface. Its scope matches the expanded
  // check exposed by tiered CLI lint, not the unchanged legacy flat command.
  const pages = await collectAllPages(root, scope);
  const existing = new Set(pages.map((page) => path.basename(page.filePath, ".md").toLowerCase()));
  // The SAME pending set the linter consults: a link the linter reports as
  // info-level pending-target is not broken, and "cannot be repaired
  // automatically" would be wrong advice about a page that is merely awaiting
  // review. The two authorities must disagree about NO link.
  const pending = await listLinkResolvablePendingSlugs(root);
  const byTitle = pagesByTitleSlug(pages);
  const plans: LintFixPlanV1[] = [];
  for (const page of pages) {
    for (const { captured, line } of findMatchesInContent(page.content, WIKILINK)) {
      const target = captured.split("|")[0]!.trim();
      const slug = slugify(target);
      if (existing.has(slug) || pending.has(slug)) continue;
      plans.push(planForBrokenLink(page.filePath, line, captured, target, byTitle.get(slug) ?? []));
    }
  }
  return plans;
}

/** The repair for one broken link: retarget it, or explain why nobody can. */
function planForBrokenLink(
  file: string, line: number, captured: string, target: string, candidates: readonly string[],
): LintFixPlanV1 {
  if (candidates.length !== 1) {
    // Zero candidates: nothing to point at. More than one: pointing at either
    // would be a guess, and a confident wrong edit is worse than advice.
    const why = candidates.length === 0
      ? "no page carries that title"
      : `${candidates.length} pages carry that title, so the target is ambiguous`;
    return {
      kind: "recommendation", rule: "broken-wikilink", file,
      advice: `[[${target}]] cannot be repaired automatically: ${why}`,
    };
  }
  // The page exists under a different filename than its title — keep the
  // author's visible text and point the link at the real slug.
  return {
    kind: "fix", rule: "broken-wikilink",
    edit: { file, line, from: `[[${captured}]]`, to: `[[${candidates[0]}|${target}]]` },
  };
}
