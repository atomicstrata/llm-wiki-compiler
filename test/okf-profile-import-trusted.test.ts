/**
 * @file The F4 / Invariant-4 guardrail for typed OKF import (CLP 7.6 Task 4):
 * under `--trusted`, a typed profile-entity doc lands LIVE ONLY through the trust
 * planner (`wiki/<entityType>/<slug>.md`), NEVER through the legacy `writeAll`.
 *
 * The structural (non-spy) proof: a typed doc whose body VIOLATES the field
 * contract does NOT land live under `--trusted` — `writeAll` would have written it
 * blindly, the planner refuses — and it remains STAGED as a mismatch-fallback
 * candidate. In the SAME import, an untyped concept still goes live via `writeAll`
 * (parity), and a valid typed doc lands at `wiki/papers/<slug>.md` (a path
 * `writeAll` can never write, so only the planner could have produced it).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { installResearchProfile } from "./fixtures/research-profile.js";
import { writeTypedBundle as writeBundle } from "./fixtures/okf-typed-bundle.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** A valid `papers` OKF doc (title + required authors + a create-legal lifecycle state). */
function validPaperDoc(): string {
  return `---\ntype: papers\nx-llmwiki:\n  entityType: papers\n  lifecycle:\n    field: stage\n    state: imported\ntitle: Good Paper\nauthors:\n  - A. Author\n---\n\nA transformer paper.\n`;
}

/** A `papers` OKF doc MISSING the required `authors` — a field-contract violation. */
function contractViolatingPaperDoc(): string {
  return `---\ntype: papers\nx-llmwiki:\n  entityType: papers\n  lifecycle:\n    field: stage\n    state: imported\ntitle: Bad Paper\n---\n\nNo authors.\n`;
}

/** True when a path exists on disk. */
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("typed OKF import — trusted promotion", () => {
  it("promotes a valid typed doc live via the planner and clears its candidate", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpit-ok-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, { "papers/good-paper.md": validPaperDoc() });
    const report = await runOkfImport(dir, b, { trusted: true });
    expect(report.typed![0].outcome).toBe("promoted-typed");
    const page = await readFile(path.join(dir, "wiki/papers/good-paper.md"), "utf-8");
    expect(page).toContain("A. Author");
    expect(page).toMatch(/stage: imported/);
    expect(await listCandidates(dir)).toHaveLength(0);
  });
});

describe("typed OKF import — F4 guardrail (writeAll never writes a typed page)", () => {
  it("keeps a contract-violating typed doc off disk while an untyped concept still goes live", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tpit-guard-"));
    await installResearchProfile(dir);
    const b = await writeBundle(dir, {
      "concepts/good.md": "---\ntype: concept\ntitle: Good\n---\n\nA concept.\n",
      "papers/bad.md": contractViolatingPaperDoc(),
    });
    const report = await runOkfImport(dir, b, { trusted: true });
    // Parity: the untyped concept lands live through writeAll exactly as before.
    expect(await exists(path.join(dir, "wiki/concepts/good.md"))).toBe(true);
    // Guardrail: the contract-violating typed doc NEVER lands live...
    expect(await exists(path.join(dir, "wiki/papers/bad.md"))).toBe(false);
    // ...and remains staged as an untyped mismatch-fallback candidate.
    expect(report.typed!.some((t) => t.outcome === "mismatch-fallback")).toBe(true);
    const candidates = await listCandidates(dir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetEntityType).toBeUndefined();
  });
});
