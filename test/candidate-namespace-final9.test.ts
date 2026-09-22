/**
 * @file test/candidate-namespace-final9.test.ts
 * @description Public candidate paths accept confined directory aliases for
 * reads and removal. Broken links and non-directory ancestors remain errors;
 * atomic publication still refuses a symlinked immediate parent.
 */

import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteCandidate,
  listCandidates,
  readCandidate,
  writeCandidate,
  type CandidateDraft,
} from "../src/compiler/candidates.js";
import {
  resolveConfinedCandidatesDir,
  UnsafeCandidateDirError,
} from "../src/compiler/candidate-store-paths.js";
import { CANDIDATES_ARCHIVE_DIR } from "../src/utils/constants.js";
import { CandidateCustodyUnavailableError } from "../src/compiler/candidate-custody.js";
import { readCandidateEntryForMutation } from "../src/compiler/candidate-read.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { CandidatePublicationUnavailableError } from "../src/compiler/candidate-publication.js";

const root = useTempRoot();

/** Minimal draft that would expose an aliased writer. */
function draft(): CandidateDraft {
  return { title: "Owned", slug: "owned", summary: "", sources: [], body: "new" };
}

/** One complete candidate record for read/delete alias probes. */
function candidateRecord(id: string): string {
  return JSON.stringify({
    id, title: "Planted", slug: "planted", summary: "", sources: [], body: "authority",
    generatedAt: "2026-01-01T00:00:00.000Z", reviewMode: "forced", heldReasons: [],
  });
}

/** Plant an alternate in-project directory and point candidates at it. */
async function plantInProjectAlias(id = "planted"): Promise<string> {
  const alternate = path.join(root.dir, "alternate-candidates");
  await mkdir(path.join(root.dir, ".llmwiki"), { recursive: true });
  await mkdir(alternate);
  await writeFile(path.join(alternate, `${id}.json`), candidateRecord(id));
  await symlink(alternate, path.join(root.dir, ".llmwiki", "candidates"));
  return path.join(alternate, `${id}.json`);
}

/** Run one assertion while the real pending namespace is unreadable. */
async function withUnreadablePending(
  assertion: (candidateId: string) => Promise<void>,
): Promise<string> {
  const candidate = await writeCandidate(root.dir, draft());
  const dir = path.join(root.dir, ".llmwiki", "candidates");
  await chmod(dir, 0o000);
  try {
    await assertion(candidate.id);
  } finally {
    await chmod(dir, 0o700);
  }
  return path.join(dir, `${candidate.id}.json`);
}

describe("Confined candidate namespaces", () => {
  it("lists a stable in-project pending alias", async () => {
    await plantInProjectAlias();

    expect((await listCandidates(root.dir)).map((entry) => entry.id)).toEqual(["planted"]);
  });

  it("rejects a stable in-project pending alias before writing alternate bytes", async () => {
    const planted = await plantInProjectAlias();
    const before = await readFile(planted, "utf8");

    await expect(writeCandidate(root.dir, draft())).rejects.toBeInstanceOf(CandidatePublicationUnavailableError);
    expect(await readFile(planted, "utf8")).toBe(before);
  });

  it("reads and deletes through a stable in-project pending alias", async () => {
    const planted = await plantInProjectAlias();

    expect((await readCandidate(root.dir, "planted"))?.id).toBe("planted");
    await expect(deleteCandidate(root.dir, "planted")).resolves.toBe(true);
    await expect(lstat(planted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["dangling", "loop"])("rejects a %s pending link instead of reporting empty", async (kind) => {
    const llmwiki = path.join(root.dir, ".llmwiki");
    const candidates = path.join(llmwiki, "candidates");
    await mkdir(llmwiki);
    await symlink(kind === "loop" ? candidates : path.join(root.dir, "missing"), candidates);

    await expect(listCandidates(root.dir)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
  });

  it("reads a symlinked .llmwiki ancestor that stays in-project", async () => {
    const alternate = path.join(root.dir, "alternate-private", "candidates");
    await mkdir(alternate, { recursive: true });
    await writeFile(path.join(alternate, "planted.json"), candidateRecord("planted"));
    await symlink(path.dirname(alternate), path.join(root.dir, ".llmwiki"));

    expect((await listCandidates(root.dir)).map((entry) => entry.id)).toEqual(["planted"]);
  });

  it("rejects a regular file at the pending directory path with the typed boundary", async () => {
    const llmwiki = path.join(root.dir, ".llmwiki");
    const candidates = path.join(llmwiki, "candidates");
    await mkdir(llmwiki);
    await writeFile(candidates, "not-a-directory");

    await expect(listCandidates(root.dir)).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    expect((await lstat(candidates)).isFile()).toBe(true);
  });

  it("keeps advisory reads tolerant but refuses unreadable mutation authority", async () => {
    await withUnreadablePending(async (candidateId) => {
      await expect(readCandidate(root.dir, candidateId)).resolves.toBeNull();
      await expect(readCandidateEntryForMutation(root.dir, candidateId))
        .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    });
  });

  it("reports an unreadable pending namespace as typed list unavailability", async () => {
    await withUnreadablePending(async () => {
      await expect(listCandidates(root.dir))
        .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    });
  });

  it("reports unreadable delete authority without removing the candidate", async () => {
    const file = await withUnreadablePending(async (candidateId) => {
      await expect(deleteCandidate(root.dir, candidateId))
        .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    });

    expect(JSON.parse(await readFile(file, "utf8")).body).toBe("new");
  });

  it.each(["alias", "dangling", "loop", "file"])(
    "rejects an archive %s as unavailable authority",
    async (kind) => {
      const candidates = path.join(root.dir, ".llmwiki", "candidates");
      const archive = path.join(candidates, "archive");
      await mkdir(candidates, { recursive: true });
      if (kind === "file") await writeFile(archive, "not-a-directory");
      else {
        const target = kind === "alias" ? path.join(root.dir, "alternate-archive")
          : kind === "loop" ? archive : path.join(root.dir, "missing-archive");
        if (kind === "alias") await mkdir(target);
        await symlink(target, archive);
      }

      if (kind === "alias") {
        expect(await resolveConfinedCandidatesDir(root.dir, CANDIDATES_ARCHIVE_DIR))
          .toMatch(/alternate-archive$/);
      } else {
        await expect(resolveConfinedCandidatesDir(root.dir, CANDIDATES_ARCHIVE_DIR))
          .rejects.toBeInstanceOf(UnsafeCandidateDirError);
      }
    },
  );
});
