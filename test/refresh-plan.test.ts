/**
 * Tests for resolveStaleRefresh — the read-only resolver that computes a
 * RefreshPlan from a single freshness snapshot. Covers all four page outcomes
 * (recompiled, shared-kept, computed-orphaned, already-orphaned) plus the
 * newSkipped/changeFilter/knownAffected helpers and corrupt-state short-circuit.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { resolveStaleRefresh } from "../src/compiler/refresh-plan.js";
import { makeLintTempRoot } from "./fixtures/lint-temp-root.js";
import {
  writeSourceState,
  writeSourceFile,
  sha256Hex,
  writeCorruptTestStateJson,
} from "./fixtures/state-json.js";
import { writePage } from "./fixtures/write-page.js";

describe("resolveStaleRefresh", () => {
  it("classifies a changed-owner stale page as recompiled", async () => {
    const { root, writeConceptPage } = await makeLintTempRoot("refresh-plan-changed");
    await writeConceptPage(
      "topic",
      `---\ntitle: Topic\nsources: [a.md]\nsummary: s\ncreatedAt: t\n---\nbody`,
    );
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] },
    });
    await writeSourceFile(root, "a.md", "NEW body");

    const { stateStatus, plan } = await resolveStaleRefresh(root);
    expect(stateStatus).toBe("ok");
    expect(plan!.recompiledPages).toContain("topic");
    expect(plan!.changedOwners).toContain("a.md");
    expect(plan!.sharedKeptPages).toEqual([]);
  });

  it("classifies an all-owners-deleted page as computed-orphaned", async () => {
    const { root, writeConceptPage } = await makeLintTempRoot("refresh-plan-orphan");
    await writeConceptPage(
      "topic",
      `---\ntitle: Topic\nsources: [a.md]\nsummary: s\ncreatedAt: t\n---\nbody`,
    );
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("body"), concepts: ["topic"] },
    });
    // a.md NOT written to disk → deleted

    const { plan } = await resolveStaleRefresh(root);
    expect(plan!.computedOrphanedPages).toContain("topic");
    expect(plan!.deletedOwners).toContain("a.md");
    expect(plan!.recompiledPages).toEqual([]);
  });

  it("classifies a partial-deletion page (live unchanged + deleted owner) as shared-kept, not recompiled", async () => {
    const { root, writeConceptPage } = await makeLintTempRoot("refresh-plan-shared");
    await writeConceptPage(
      "x",
      `---\ntitle: X\nsources: [a.md, b.md]\nsummary: s\ncreatedAt: t\n---\nbody`,
    );
    const aBody = "A body";
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex(aBody), concepts: ["x"] },
      "b.md": { hash: sha256Hex("B body"), concepts: ["x"] },
    });
    await writeSourceFile(root, "a.md", aBody); // unchanged live owner
    // b.md NOT written → deleted

    const { plan } = await resolveStaleRefresh(root);
    expect(plan!.sharedKeptPages).toContain("x");
    expect(plan!.recompiledPages).not.toContain("x");
    expect(plan!.changedOwners).not.toContain("a.md");
    expect(plan!.deletedOwners).toContain("b.md");
  });

  it("reports a frontmatter-orphaned page with no owners as already-orphaned (no action)", async () => {
    const { root } = await makeLintTempRoot("refresh-plan-already-orphaned");
    await writePage(
      path.join(root, "wiki", "concepts"),
      "old",
      { title: "Old", sources: [], summary: "s", createdAt: "t", orphaned: true },
      "body",
    );
    await writeSourceState(root, {}); // no owners

    const { plan } = await resolveStaleRefresh(root);
    expect(plan!.alreadyOrphanedPages).toContain("old");
    expect(plan!.changedOwners).toEqual([]);
    expect(plan!.deletedOwners).toEqual([]);
  });

  it("lists new sources separately and excludes them from the changeFilter", async () => {
    const { root, writeConceptPage } = await makeLintTempRoot("refresh-plan-new");
    await writeConceptPage(
      "topic",
      `---\ntitle: Topic\nsources: [a.md]\nsummary: s\ncreatedAt: t\n---\nbody`,
    );
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] },
    });
    await writeSourceFile(root, "a.md", "NEW body");
    await writeSourceFile(root, "new.md", "brand new");

    const { plan } = await resolveStaleRefresh(root);
    expect(plan!.newSkipped).toContain("new.md");
    expect(plan!.changeFilter({ file: "new.md", status: "new" })).toBe(false);
    expect(plan!.changeFilter({ file: "a.md", status: "changed" })).toBe(true);
  });

  it("knownAffected pulls in an unchanged co-contributor but not a deleted owner", async () => {
    const { root, writeConceptPage } = await makeLintTempRoot("refresh-plan-known-affected");
    await writeConceptPage(
      "x",
      `---\ntitle: X\nsources: [a.md, b.md, c.md]\nsummary: s\ncreatedAt: t\n---\nbody`,
    );
    const cBody = "C body";
    await writeSourceState(root, {
      "a.md": { hash: sha256Hex("OLD A"), concepts: ["x"] },
      "b.md": { hash: sha256Hex("B body"), concepts: ["x"] },
      "c.md": { hash: sha256Hex(cBody), concepts: ["x"] },
    });
    await writeSourceFile(root, "a.md", "NEW A"); // changed owner
    await writeSourceFile(root, "c.md", cBody); // unchanged co-contributor
    // b.md NOT on disk → deleted

    const { plan } = await resolveStaleRefresh(root);
    expect(plan!.knownAffected).toContain("c.md"); // real co-contributor pulled in
    expect(plan!.knownAffected).not.toContain("b.md"); // deleted owner excluded
  });

  it("excludes a page with no state owners and no orphaned flag from all four outcome lists", async () => {
    const { root, writeConceptPage } = await makeLintTempRoot("refresh-plan-untracked");
    await writeConceptPage(
      "handwritten",
      `---\ntitle: Handwritten\nsources: []\nsummary: s\ncreatedAt: t\n---\nbody`,
    );
    await writeSourceState(root, {}); // no owners; page has no orphaned frontmatter

    const { plan } = await resolveStaleRefresh(root);
    expect(plan!.recompiledPages).not.toContain("handwritten");
    expect(plan!.sharedKeptPages).not.toContain("handwritten");
    expect(plan!.computedOrphanedPages).not.toContain("handwritten");
    expect(plan!.alreadyOrphanedPages).not.toContain("handwritten");
  });

  it("returns stateStatus corrupt with a null plan and writes no .bak on corrupt state", async () => {
    const { root } = await makeLintTempRoot("refresh-plan-corrupt");
    await writeCorruptTestStateJson(root);

    const { stateStatus, plan } = await resolveStaleRefresh(root);
    expect(stateStatus).toBe("corrupt");
    expect(plan).toBeNull();
    expect(existsSync(path.join(root, ".llmwiki/state.json.bak"))).toBe(false);
  });
});
