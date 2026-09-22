/**
 * @file test/preparations/recursive-delete-scope.test.ts
 * @description §16 clause 5 — the reachable recursive deletes, and what bounds them.
 *
 * Recomputed as a REACHABILITY walk over the derived lifecycle closure rather than
 * a grep for `recursive: true` inside a hand-written directory list, which could
 * not see one of these a call hop away in `src/utils`. Exactly two sites exist,
 * and they resolved differently:
 *
 *   - `advisory-file.ts` — NARROWED, and clause 5 still FALSE for it. Four
 *     pathname-shaped bounds were attempted and review defeated each, ending at an
 *     ancestor symlink swapped between the check and the delete. A pathname
 *     check-then-act cannot close that race whatever it checks.
 *
 *     What changed is not a fifth bound. The remover was calling a bare recursive
 *     `rm` with NO confinement while `src/utils/confined-delete.ts` — the same
 *     directory — already owned a root-confined, parent-verified, fsynced remover
 *     that no one had routed it through. It now dispatches on the OBSERVED shape,
 *     so the tree walk survives only for a non-empty planted directory. The
 *     ancestor-swap window is unchanged and no boundary is claimed.
 *     See `plans/2026-08-04-clause-5-advisory-removal-design.md`.
 *
 *   - `attempts/custody.ts` — CLOSED here, and not by a fifth pathname rule. Its
 *     argument arrives on `AttemptLegOutcomeV1.custodyTempDir`, a field the LEG
 *     fills in, so the string is untrusted by construction. It is now bounded by
 *     PROVENANCE: only a directory `createCustodyDir` actually minted can be
 *     discarded. Shape is not consulted at all.
 *
 * The distinction that made custody tractable and the advisory not: custody has a
 * moment when the code KNOWS the directory is its own — it just created it — so
 * the answer can be captured then. The advisory has no such moment; it is handed
 * a name for something it did not make.
 */

import { existsSync } from "node:fs";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { createCustodyDir, discardCustody } from "../../src/preparations/attempts/custody.js";
import { removeAdvisoryBestEffort } from "../../src/utils/advisory-file.js";

describe("custody discard is bounded by provenance, not by path shape", () => {
  const root = useTempRoot();

  /** Discard only minted custody, leaving a symlink's target bytes untouched. */
  async function expectDiscardPreservesTarget(scratch: string, sentinel: string): Promise<void> {
    await discardCustody(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(path.join(sentinel, "keep"))).toBe(true);
  }

  it("discards a directory it actually minted", async () => {
    // The positive control. Without it every refusal below is satisfied by a
    // function that deletes nothing at all.
    const scratch = await createCustodyDir();
    await writeFile(path.join(scratch, "chunk"), "unpublished bytes");
    await discardCustody(scratch);
    expect(existsSync(scratch)).toBe(false);
  });

  it("REFUSES a leg-supplied path reached through a symlinked custody directory", async () => {
    // The reproduction that defeated the previous bound. A lexical
    // `resolve().startsWith(tmpdir + prefix)` accepted this: the name looks like
    // custody scratch while the directory is a symlink into the project, and the
    // recursive delete landed on project data.
    //
    // Provenance refuses it without inspecting the name: this string was never
    // minted. That is the whole of the fix.
    const sentinel = path.join(root.dir, "ordinary-project-data");
    await mkdir(sentinel, { recursive: true });
    await writeFile(path.join(sentinel, "keep"), "must survive");

    const impostor = path.join(await realpath(tmpdir()), `prep-attempt-custody-impostor-${process.pid}`);
    await symlink(root.dir, impostor).catch(() => {});
    try {
      await discardCustody(path.join(impostor, "ordinary-project-data"));
      expect(existsSync(path.join(sentinel, "keep"))).toBe(true);
    } finally {
      await rm(impostor, { force: true }).catch(() => {});
    }
  });

  it("REFUSES a plausible custody path that was never minted", async () => {
    // Same prefix, same parent, real directory — and still refused, because
    // shape is not what is being checked.
    const lookalike = path.join(await realpath(tmpdir()), `prep-attempt-custody-fake-${process.pid}`);
    await mkdir(lookalike, { recursive: true });
    await writeFile(path.join(lookalike, "evidence"), "not ours to delete");
    try {
      await discardCustody(lookalike);
      expect(existsSync(path.join(lookalike, "evidence"))).toBe(true);
    } finally {
      await rm(lookalike, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("REFUSES a second discard of the same directory", async () => {
    // Provenance is spent on use, so a repeated discard cannot act on a name that
    // may since have been reused by something else.
    const scratch = await createCustodyDir();
    await discardCustody(scratch);
    await mkdir(scratch, { recursive: true });
    await writeFile(path.join(scratch, "reused"), "planted after the first discard");
    try {
      await discardCustody(scratch);
      expect(existsSync(path.join(scratch, "reused"))).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not follow the minted directory itself once REPLACED by a symlink", async () => {
    // WHAT THIS COVERS, stated exactly, because it is NOT the defect that prompted
    // the change. This swaps the directory AFTER minting, and asserts the discard
    // unlinks the link instead of following it -- the property the recursive `rm`
    // rests on once provenance holds.
    //
    // The defect review reproduced was different: the previous version called
    // `realpath` on the freshly created directory before recording it, so a swap
    // landing DURING that await made the attacker's target the minted path. This
    // test does not witness that, and re-adding `realpath` leaves it green --
    // measured, not assumed.
    //
    // Nor is that race closed by removing an interval -- an OS-level window does
    // exist, and persists right up to the discard: another process able to write
    // the temp root can replace the minted name at any point. What changed is what
    // gets RECORDED. Resolving substituted the symlink's TARGET, an attacker-chosen
    // path elsewhere on disk, and deleting that is the escape. Recording the
    // literal name keeps the swapped component FINAL, and a final symlink is
    // unlinked rather than followed -- which is the property this test pins.
    const sentinel = path.join(root.dir, "swapped-project-data");
    await mkdir(sentinel, { recursive: true });
    await writeFile(path.join(sentinel, "keep"), "must survive");

    const scratch = await createCustodyDir();
    await rm(scratch, { recursive: true, force: true });
    await symlink(sentinel, scratch);

    await expectDiscardPreservesTarget(scratch, sentinel);
  });

  it("does not follow a symlink PLANTED INSIDE a minted directory", async () => {
    // The remaining question once provenance holds: the delete is still
    // recursive, so what happens to links found within it? Verified rather than
    // asserted from `rm` documentation, because the whole boundary rests on it.
    const sentinel = path.join(root.dir, "linked-project-data");
    await mkdir(sentinel, { recursive: true });
    await writeFile(path.join(sentinel, "keep"), "must survive");

    const scratch = await createCustodyDir();
    await symlink(sentinel, path.join(scratch, "escape")).catch(() => {});
    await expectDiscardPreservesTarget(scratch, sentinel);
  });
});

describe("advisory removal dispatches on the observed shape", () => {
  const root = useTempRoot();

  /** The advisory lives directly inside its runs directory, as `cancelFile` builds it. */
  async function advisoryAt(name: string): Promise<{ runs: string; file: string }> {
    const runs = path.join(root.dir, "runs");
    await mkdir(runs, { recursive: true });
    return { runs, file: path.join(runs, name) };
  }

  it("removes an ordinary regular-file advisory", async () => {
    // The positive control. Without it every refusal below is satisfied by a
    // remover that does nothing at all.
    const { runs, file } = await advisoryAt("run-plain.cancel");
    await writeFile(file, "{}");
    await removeAdvisoryBestEffort(root.dir, file, runs);
    expect(existsSync(file)).toBe(false);
  });

  it("removes a NON-EMPTY planted directory, so cancellation is not stranded", async () => {
    // The residual recursion, pinned deliberately. Leaving this shape in place is
    // what three cancel-semantics tests refuted: clearing the untrusted advisory
    // is what unwedges the run.
    const { runs, file } = await advisoryAt("run-dir.cancel");
    await mkdir(path.join(file, "nested"), { recursive: true });
    await writeFile(path.join(file, "nested", "junk"), "planted");
    await removeAdvisoryBestEffort(root.dir, file, runs);
    expect(existsSync(file)).toBe(false);
  });

  it("unlinks a symlinked advisory WITHOUT deleting its target", async () => {
    // `unlink` removes the link, never what it names. Verified rather than
    // asserted, because the symlink branch is the one that skips confinement.
    const outside = path.join(root.dir, "outside-the-runs-tree");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep"), "must survive");

    const { runs, file } = await advisoryAt("run-link.cancel");
    await symlink(outside, file);
    await removeAdvisoryBestEffort(root.dir, file, runs);

    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(outside, "keep"))).toBe(true);
  });

  it("REFUSES a regular-file removal reached through a symlinked PARENT", async () => {
    // The confinement that the bare recursive `rm` did not have. `runs` is a
    // symlink out of the project, so the leaf resolves outside it; the confined
    // primitive re-resolves the PARENT and refuses rather than following.
    //
    // This does NOT close the ancestor-swap race -- a swap landing between the
    // check and the unlink still wins, which is why clause 5 stays FALSE. It pins
    // that a parent already redirected at call time is not followed.
    const elsewhere = path.join(root.dir, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "run-swap.cancel"), "not ours to delete");

    const runs = path.join(root.dir, "redirected-runs");
    await symlink(elsewhere, runs);

    await removeAdvisoryBestEffort(root.dir, path.join(runs, "run-swap.cancel"), runs);
    expect(existsSync(path.join(elsewhere, "run-swap.cancel"))).toBe(true);
  });
});
