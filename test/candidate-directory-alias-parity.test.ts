/**
 * @file Public in-root directory aliases remain usable without admitting an
 * escaping namespace or relaxing explicit strict authority scans.
 */
import { rename, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { archiveCandidate, listCandidates, writeCandidate } from "../src/compiler/candidates.js";
import { selectCandidateEntriesForMutation } from "../src/compiler/candidate-selection.js";
import { UnsafeCandidateDirError } from "../src/compiler/candidate-store-paths.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

describe("public candidate directory aliases", () => {
  it("reads and archives through an in-root alias, but strict scans refuse it", async () => {
    const retained = path.join(root.dir, "retained-candidates");
    const candidate = await writeCandidate(root.dir, {
      title: "Alias", slug: "alias", summary: "", sources: [], body: "First",
    });
    await rename(path.join(root.dir, ".llmwiki", "candidates"), retained);
    await symlink(retained, path.join(root.dir, ".llmwiki", "candidates"));
    expect((await listCandidates(root.dir)).map(item => item.id)).toEqual([candidate.id]);
    await expect(selectCandidateEntriesForMutation(root.dir, () => true))
      .rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect(await archiveCandidate(root.dir, candidate.id)).toBe(true);
    expect(await listCandidates(root.dir)).toEqual([]);
  });
});
