/**
 * @file test/page-apply-net-growth-floor.test.ts
 * @description The net-growth floor exemption for page UPDATES (S5 apply floor).
 *
 * The shared per-page floor (`assertFloorAtApply` → `checkResourceLimit`) caps a
 * NEW body at `resourceCapForOrigin(origin)`. That cap is sized for NEW content,
 * so applying it to an UPDATE that adds NONE permanently floor-blocks a legal
 * transition of an ALREADY-LARGE page (e.g. a lifecycle field flip on a page that
 * grew past the cap by other means). The exemption gates an update on NET GROWTH:
 * the effective cap is `max(originCap, existingOnDiskChars)`.
 *
 * Coverage:
 *  1. Teeth (product fix): an over-cap on-disk entity page → a legal lifecycle
 *     transition (adds no content) SUCCEEDS. FAILS pre-fix with `MutationFloorError`.
 *  2. A growing update beyond `max(cap, existingChars)` is still blocked.
 *  3. A `create` over the absolute cap is still blocked (no exemption).
 *  4. A normal-sized update (within cap) is allowed (unchanged behavior).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { rm, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { createWiki } from "../src/index.js";
import { applyPageMutationLocked } from "../src/trust/page-apply.js";
import { openBatch, commitBatch, JournalPreStateUnreadableError } from "../src/trust/journal.js";
import type { PagePlannedMutation } from "../src/trust/planner.js";
import { MAX_SOURCE_CHARS } from "../src/utils/constants.js";
import { makeResearchLiteProjectRoot, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";

/** A research-lite profile (ideas lifecycle: proposed→testing→tested→…). */
function profile(): ProfilePack {
  return { ...RESEARCH_LITE_PROFILE } as ProfilePack;
}

/** A prose body padded well past `MAX_SOURCE_CHARS` so the page is over-cap. */
function overCapProse(): string {
  return "x".repeat(MAX_SOURCE_CHARS + 5_000);
}

/** A valid, allowed `update` page mutation targeting an ideas entity page. */
function ideaUpdate(slug: string, body: string): PagePlannedMutation {
  return {
    kind: "page",
    operation: "update",
    target: { entityType: "ideas", slug, id: `ideas/${slug}` as EntityId },
    body,
    provenance: { origin: "agent", decision: "allow", reviewRouted: false },
  };
}

let root = "";
beforeEach(async () => {
  root = await makeResearchLiteProjectRoot("page-apply-floor-", profile());
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("net-growth floor exemption for page updates", () => {
  it("admits a legal lifecycle transition of an already-over-cap page (teeth)", async () => {
    const pagePath = path.join(root, "wiki/ideas/sparse-routing.md");
    // status FIRST so flipping proposed(8)→testing(7) shrinks the body — no growth.
    await writeFile(pagePath, `---\nstatus: proposed\n---\n\n${overCapProse()}\n`, "utf8");
    const wiki = createWiki({ root });
    await wiki.transitionLifecycle({ entityType: "ideas", slug: "sparse-routing", toState: "testing" });
    expect(await readFile(pagePath, "utf8")).toContain("status: testing");
  });

  it("still blocks an update that GROWS beyond max(cap, existingChars)", async () => {
    const slug = "sparse-routing";
    const pagePath = path.join(root, "wiki/ideas", `${slug}.md`);
    await writeFile(pagePath, `---\nstatus: proposed\n---\n\n${overCapProse()}\n`, "utf8");
    const existingChars = (await readFile(pagePath, "utf8")).length;
    const grown = `---\nstatus: proposed\n---\n\n${"y".repeat(existingChars + 1_000)}\n`;
    const batch = await openBatch(root);
    const attempt = applyPageMutationLocked(root, ideaUpdate(slug, grown), batch);
    await expect(attempt).rejects.toThrow(/mutation-floor/);
  });

  it("still caps a create at the absolute cap (no exemption for create)", async () => {
    await mkdir(path.join(root, "wiki/ideas"), { recursive: true });
    const create: PagePlannedMutation = {
      kind: "page",
      operation: "create",
      target: { entityType: "ideas", slug: "brand-new", id: "ideas/brand-new" as EntityId },
      body: `---\nstatus: proposed\n---\n\n${overCapProse()}\n`,
      provenance: { origin: "agent", decision: "allow", reviewRouted: false },
    };
    const batch = await openBatch(root);
    const attempt = applyPageMutationLocked(root, create, batch);
    await expect(attempt).rejects.toThrow(/mutation-floor/);
  });

  it("refuses an update whose page path is a symlinked leaf (cap read no longer follows it)", async () => {
    const slug = "symlinked-leaf";
    const pageDir = path.join(root, "wiki/ideas");
    await mkdir(pageDir, { recursive: true });
    // An IN-ROOT over-cap file the page path symlinks to (a symlink→outside would be
    // rejected up front by confineUnderRoot; this in-root link passes it). Pre-fix,
    // effectiveMaxChars followed the link and granted a huge net-growth exemption and
    // recordPreState copied its bytes into the journal. The no-follow reader now
    // rejects the leaf link itself (ELOOP → unavailable) and the mutation is refused.
    const linkTarget = path.join(pageDir, "real-big.md");
    await writeFile(linkTarget, overCapProse(), "utf8");
    await symlink(linkTarget, path.join(pageDir, `${slug}.md`));
    const batch = await openBatch(root);
    const attempt = applyPageMutationLocked(root, ideaUpdate(slug, "---\nstatus: testing\n---\n\nshort.\n"), batch);
    await expect(attempt).rejects.toThrow(JournalPreStateUnreadableError);
  });

  it("leaves a normal within-cap update unaffected (allowed)", async () => {
    const slug = "sparse-routing";
    const pagePath = path.join(root, "wiki/ideas", `${slug}.md`);
    await writeFile(pagePath, "---\nstatus: proposed\n---\n\nshort.\n", "utf8");
    const next = "---\nstatus: testing\n---\n\nstill short.\n";
    const batch = await openBatch(root);
    await applyPageMutationLocked(root, ideaUpdate(slug, next), batch);
    await commitBatch(batch);
    expect(await readFile(pagePath, "utf8")).toContain("status: testing");
  });
});
