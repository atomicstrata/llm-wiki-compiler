/**
 * @file src/commands/lint-fix-propose.ts
 * @description `lint --fix-propose <n>`: turn the nth deterministic lint fix into
 * a reviewable PROPOSAL rather than applying it. It applies the fix's edit to the
 * current target page in memory, captures the page's content hash, and stages a
 * review candidate — writing NOTHING to `wiki/`. The operator applies it later
 * with `review approve <id>`, which is REFUSED if the target page changed since
 * the proposal (the stale-state guard), so a stale fix never clobbers newer
 * content. It is a thin bridge onto the existing reviewed mutation path; it does
 * not itself apply.
 */

import path from "path";
import { readFile } from "fs/promises";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import { planLintFixes, type LintFixEditV1 } from "../linter/fix-plan.js";
import { writeCandidate } from "../compiler/candidates.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import * as output from "../utils/output.js";

/** The fixable findings, in the stable order `--fix-preview` numbers them. */
async function fixableFindings(root: string): Promise<LintFixEditV1[]> {
  const plans = await planLintFixes(root);
  return plans.flatMap((plan) => (plan.kind === "fix" ? [plan.edit] : []));
}

/** Apply one wikilink edit to the page content, on its own line. */
function applyEdit(content: string, edit: LintFixEditV1): string {
  const lines = content.split("\n");
  const index = edit.line - 1;
  if (index < 0 || index >= lines.length) return content.replace(edit.from, edit.to);
  lines[index] = lines[index]!.replace(edit.from, edit.to);
  return lines.join("\n");
}

type TargetRouting =
  | { ok: true; meta: { targetDirectory?: "concepts" | "queries"; targetEntityType?: string } }
  | { ok: false; reason: string };

/**
 * Map the target page's wiki subdir to the candidate's routing metadata. The
 * candidate model addresses exactly one level under `wiki/`: `concepts`,
 * `queries`, or a single typed-entity directory. A page directly in `wiki/` or
 * nested deeper (e.g. `wiki/research/papers/foo.md`) cannot be faithfully
 * routed — the approval write would land at the WRONG path — so it is REFUSED
 * rather than silently mis-routed (fail closed). Full nested support is a
 * separate routing-model change.
 */
function targetMetadata(root: string, file: string): TargetRouting {
  const rel = path.relative(path.join(root, "wiki"), file);
  const dir = path.dirname(rel);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "the target page is outside wiki/" };
  }
  if (dir === "queries" || dir === "concepts") return { ok: true, meta: { targetDirectory: dir } };
  if (dir === "." || dir.includes(path.sep)) {
    return { ok: false, reason: `cannot route ${dir}/ — only wiki/concepts, wiki/queries, or a single typed-entity directory are supported` };
  }
  return { ok: true, meta: { targetEntityType: dir } };
}

/**
 * Stage the nth deterministic fix as a review candidate.
 * @param n - 1-based index into the fixable findings (as `--fix-preview` numbers them).
 * @returns Process exit code: 0 on a staged proposal, 1 when `n` names no fix.
 */
export async function lintFixProposeCommand(n: number): Promise<number> {
  const root = process.cwd();
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    return await proposeLocked(root, n);
  } finally {
    await releaseLock(root);
  }
}

/** Plan and retain the proposal under the same mutation-authority boundary. */
async function proposeLocked(root: string, n: number): Promise<number> {
  const fixes = await fixableFindings(root);
  if (!Number.isInteger(n) || n < 1 || n > fixes.length) {
    output.status("!", output.error(
      `No fixable finding #${n}. Run \`llmwiki lint --fix-preview\` to see the ${fixes.length} numbered fix(es).`,
    ));
    return 1;
  }
  const edit = fixes[n - 1]!;
  const routing = targetMetadata(root, edit.file);
  if (!routing.ok) {
    output.status("!", output.error(`Cannot propose a fix for ${edit.file}:${edit.line}: ${routing.reason}.`));
    return 1;
  }
  const current = await readFile(edit.file, "utf8");
  const meta = parseFrontmatter(current).meta as { title?: unknown; summary?: unknown };
  const slug = path.basename(edit.file, ".md");
  const candidate = await writeCandidate(root, {
    title: typeof meta.title === "string" ? meta.title : slug,
    slug,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    sources: [],
    body: applyEdit(current, edit),
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
    expectedTargetHash: sha256Text(current),
    ...routing.meta,
  });
  output.status("→", output.info(
    `Proposed fix for ${edit.file}:${edit.line} as review candidate ${output.source(candidate.id)}. ` +
      `Apply with: llmwiki review approve ${candidate.id}`,
  ));
  return 0;
}
