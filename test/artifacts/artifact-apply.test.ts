import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { readFile, writeFile, rm, mkdir, readdir, symlink, readlink, open, access } from "fs/promises";
import { makeResearchLikeRoot } from "../fixtures/artifact-root.js"; // profile with the experiment-result artifact
import { makeTempRoot } from "../fixtures/temp-root.js";
import { makeOutsideDir } from "../fixtures/outside-dir.js";
import { makeFifo } from "../fixtures/fifo.js"; // reuse/extract the repo's existing mkfifo helper
import { applyApprovedMutations } from "../../src/trust/executor.js";
import { replayJournal } from "../../src/trust/journal.js";
import { JOURNAL_PRESTATE_MAX_BYTES, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { artifactPaths, hashArtifactBody } from "../../src/artifacts/store.js";

/** Recursively confirm no file under `dir` (including any quarantine subdir) contains `marker`. Absent dir is clean. */
async function journalIsClean(dir: string, marker: string): Promise<boolean> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return true; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!(await journalIsClean(full, marker))) return false;
    } else if ((await readFile(full, "utf8").catch(() => "")).includes(marker)) {
      return false;
    }
  }
  return true;
}

const mutation = { kind: "artifact" as const, artifactType: "experiment-result", slug: "probe", body: `{"accuracy":0.9}`, origin: "cli" as const };
afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });

/** Shared seed: granted write of `mutation`, returning the root + bytes path. */
async function writtenOnce(prefix: string) {
  const root = await makeResearchLikeRoot(prefix);
  process.env.LLMWIKI_TRUSTED_WRITE = "*";
  await applyApprovedMutations(root, [mutation]);
  const { bytesPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
  return { root, bytesPath };
}

describe("artifact write via applyApprovedMutations", () => {
  it("refuses without the grant, advising LLMWIKI_TRUSTED_WRITE (nothing written)", async () => {
    const root = await makeResearchLikeRoot("artifact-refuse");
    await expect(applyApprovedMutations(root, [mutation])).rejects.toThrow(/LLMWIKI_TRUSTED_WRITE/);
  });
  it("DENIES an undeclared artifact type WITHOUT the grant hint (a grant would not help)", async () => {
    const root = await makeResearchLikeRoot("artifact-undeclared");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const attempt = applyApprovedMutations(root, [{ ...mutation, artifactType: "nope" }]);
    await expect(attempt).rejects.toThrow(/not declared/);
    await expect(attempt).rejects.not.toThrow(/LLMWIKI_TRUSTED_WRITE/);
  });
  it("DENIES a body-contract violation as a composed decision, even with the grant", async () => {
    const root = await makeResearchLikeRoot("artifact-bad-body");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const attempt = applyApprovedMutations(root, [{ ...mutation, body: `{"accuracy":"high"}` }]);
    await expect(attempt).rejects.toThrow(/deny/); // ArtifactWriteDeniedError carries the composed decision
    await expect(attempt).rejects.not.toThrow(/LLMWIKI_TRUSTED_WRITE/); // a planner block is not a missing-grant refusal
  });
  it("DENIES with no active profile, WITHOUT the grant hint (a grant would not help)", async () => {
    const root = await makeTempRoot("artifact-no-profile"); // no .llmwiki/profile.json
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const attempt = applyApprovedMutations(root, [mutation]);
    await expect(attempt).rejects.toThrow(/deny|no profile/);
    await expect(attempt).rejects.not.toThrow(/LLMWIKI_TRUSTED_WRITE/);
  });
  it("applies live with the grant and records the manifest hash", async () => {
    const root = await makeResearchLikeRoot("artifact-apply");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const [result] = await applyApprovedMutations(root, [mutation]);
    expect(result.kind === "artifact" && result.ref.sha256).toBe(hashArtifactBody(mutation.body));
    const { bytesPath } = artifactPaths(root, "experiment-result", "probe", "result.json");
    expect(await readFile(bytesPath, "utf8")).toBe(mutation.body);
  });
  it("is a no-op on identical re-submit (applied-once)", async () => {
    const { root } = await writtenOnce("artifact-once");
    const [again] = await applyApprovedMutations(root, [mutation]);
    expect(again.kind === "artifact" && again.ref.sha256).toBe(hashArtifactBody(mutation.body));
  });
  it("REPAIRS the body on re-submit when it was replaced out-of-band under a stale manifest", async () => {
    const { root, bytesPath } = await writtenOnce("artifact-repair");
    await writeFile(bytesPath, `{"accuracy":0.0}`); // out-of-band replace; manifest still matches the mutation
    await applyApprovedMutations(root, [mutation]); // must NOT no-op on the lying manifest
    expect(await readFile(bytesPath, "utf8")).toBe(mutation.body); // bytes restored, not "reported done"
  });
  it("REPAIRS the body on re-submit when it was deleted out-of-band (manifest orphaned)", async () => {
    const { root, bytesPath } = await writtenOnce("artifact-repair-absent");
    await rm(bytesPath);
    await applyApprovedMutations(root, [mutation]);
    expect(await readFile(bytesPath, "utf8")).toBe(mutation.body);
  });
  it("REPAIRS the body on re-submit when it was replaced out-of-band with an OVERSIZE body (not treated as already-applied)", async () => {
    const { root, bytesPath } = await writtenOnce("artifact-repair-oversize");
    await writeFile(bytesPath, "x".repeat(70000)); // out-of-band replace, over maxBytes; manifest still matches the mutation
    await applyApprovedMutations(root, [mutation]); // an on-disk oversize body must never read as "already applied"
    expect(await readFile(bytesPath, "utf8")).toBe(mutation.body); // bytes restored, not left oversize
  });
  it("refuses a pre-existing SYMLINK at the target before journaling (no pre-state read-through)", async () => {
    const root = await makeResearchLikeRoot("artifact-symlink-target");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "secret"), "SECRET");
    const { bytesPath, expectedDir } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(expectedDir, { recursive: true });
    await symlink(path.join(outside, "secret"), bytesPath);
    await expect(applyApprovedMutations(root, [mutation])).rejects.toThrow(/not a regular file/);
    expect(await readlink(bytesPath)).toContain("secret"); // untouched — nothing journaled or replaced
  });
  it("refuses a pre-existing FIFO at the target promptly (no hang under the lock)", async () => {
    const root = await makeResearchLikeRoot("artifact-fifo-target");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const { bytesPath, expectedDir } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(expectedDir, { recursive: true });
    await makeFifo(bytesPath); // reuse the repo's existing mkfifo test helper (see the FIFO tests for readCappedNoFollow)
    await expect(applyApprovedMutations(root, [mutation])).rejects.toThrow(/not a regular file/);
  });
  it("refuses a SYMLINKED PARENT DIRECTORY before journaling (no outside bytes copied into the journal)", async () => {
    const root = await makeResearchLikeRoot("artifact-symlink-parent");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "result.json"), `{"accuracy":0.9,"marker":"TOP-SECRET"}`);
    const { expectedDir } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(path.dirname(expectedDir), { recursive: true });
    await symlink(outside, expectedDir); // lstat on the leaf alone traverses this planted parent symlink
    await expect(applyApprovedMutations(root, [mutation])).rejects.toThrow();
    expect(await journalIsClean(path.join(root, ".llmwiki", "journal"), "TOP-SECRET")).toBe(true);
  });
  it("refuses when the SECOND recordPreState (manifest target) is over-cap, self-heals via replayJournal (no partial write, no stuck batch)", async () => {
    const root = await makeResearchLikeRoot("artifact-manifest-overcap");
    process.env.LLMWIKI_TRUSTED_WRITE = "*";
    const { bytesPath, manifestPath, expectedDir } = artifactPaths(root, "experiment-result", "probe", "result.json");
    await mkdir(expectedDir, { recursive: true });
    // A pre-existing, over-cap manifest: a REGULAR file (passes the pre-journal
    // `assertTargetsRegularOrAbsent` isFile() gate) but too large for recordPreState's
    // own JOURNAL_PRESTATE_MAX_BYTES cap — the only way to reach that SECOND
    // recordPreState's own refusal on the real artifact path (a symlink/FIFO there
    // is already caught earlier, before journaling begins).
    const handle = await open(manifestPath, "w");
    await handle.truncate(JOURNAL_PRESTATE_MAX_BYTES + 1);
    await handle.close();

    await expect(applyApprovedMutations(root, [mutation])).rejects.toThrow(/unreadable/);
    await expect(access(bytesPath)).rejects.toThrow(); // record-before-write held: nothing written

    const journalDir = path.join(root, LLMWIKI_DIR, "journal");
    const pending = (await readdir(journalDir)).filter((f) => f.endsWith(".json"));
    expect(pending).toHaveLength(1); // one dangling pending batch (bytesPath's captured "absent" entry)

    await replayJournal(root);
    await expect(access(bytesPath)).rejects.toThrow(); // still nothing written — no data loss
    expect((await readdir(journalDir)).filter((f) => f.endsWith(".json"))).toHaveLength(0); // reverted+pruned, no stuck state
  });
});
