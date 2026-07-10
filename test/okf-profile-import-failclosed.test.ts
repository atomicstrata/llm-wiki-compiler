/**
 * @file Fail-closed regression for OKF import against a PRESENT-but-broken active
 * profile. The profile loader is fail-closed by contract: a present but
 * unparseable/invalid `.llmwiki/profile.json` is a hard error, never a silent
 * degrade to the default profile (which would change every entity's identity).
 *
 * OKF import MUST honour that: a broken active profile aborts the import — it must
 * NOT be swallowed into the untyped/default routing, because under `--trusted` an
 * untyped doc is written LIVE via the legacy `writeAll` path, so a typed doc like
 * `papers/foo.md` would silently land live as an untyped page, bypassing typed
 * routing (the F4 guardrail, field contracts, lifecycle/artifact gates) entirely.
 * Both untrusted and trusted imports must reject and write NOTHING.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, readdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { ProfileLoadError } from "../src/profile/load.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { writeTypedBundle as writeBundle } from "./fixtures/okf-typed-bundle.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** A `papers` OKF doc that, under a valid research profile, would route through the typed planner. */
function typedPaperDoc(): string {
  return `---\ntype: papers\nx-llmwiki:\n  entityType: papers\n  lifecycle:\n    field: stage\n    state: imported\ntitle: A Paper\nauthors:\n  - A. Author\n---\n\nProse.\n`;
}

/** Write a PRESENT but unparseable `.llmwiki/profile.json` (broken → loader fails closed). */
async function installBrokenProfile(root: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), "{ this is not valid json ", "utf8");
}

/** True when `wiki/` holds no page files (import wrote nothing live). */
async function wikiIsEmpty(root: string): Promise<boolean> {
  try { return (await readdir(path.join(root, "wiki"))).length === 0; }
  catch { return true; }
}

describe("OKF import fails closed on a present-but-broken active profile", () => {
  it("untrusted import rejects and stages nothing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-failclosed-untrusted-"));
    await installBrokenProfile(dir);
    const b = await writeBundle(dir, { "papers/foo.md": typedPaperDoc() });
    await expect(runOkfImport(dir, b, {})).rejects.toBeInstanceOf(ProfileLoadError);
    expect(await listCandidates(dir)).toHaveLength(0);
    expect(await wikiIsEmpty(dir)).toBe(true);
  });

  it("trusted import rejects — no typed doc leaks live via writeAll", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-failclosed-trusted-"));
    await installBrokenProfile(dir);
    const b = await writeBundle(dir, { "papers/foo.md": typedPaperDoc() });
    await expect(runOkfImport(dir, b, { trusted: true })).rejects.toBeInstanceOf(ProfileLoadError);
    await expect(stat(path.join(dir, "wiki/papers/foo.md"))).rejects.toThrow();
    expect(await listCandidates(dir)).toHaveLength(0);
    expect(await wikiIsEmpty(dir)).toBe(true);
  });
});
