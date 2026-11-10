/**
 * @file test/storage/candidate-record-dirs.test.ts
 * @description Routing witness for the pending review-candidate queue's
 * tolerant reads: the REAL list, read and paging logic of
 * `src/compiler/candidate-read.ts` runs over an in-memory record-directory
 * binding, with no directory anywhere.
 *
 * The binding here is a test double holding a listing and leaf texts. It
 * decides nothing. Which entries are candidates, what is skipped, what a
 * failed read means in tolerant and strict mode, and each ordering all come
 * from the production module. The cases pin the three behaviours a port could
 * most easily blur: the tolerant list orders by generation time ONLY (equal
 * times keep the listing order), the identity page orders ids by UTF-16 code
 * unit, and a failed RESOLUTION is never treated as a missing candidate.
 * The targeted loads and the bounded page are then shown over the same double,
 * with their CLI line and exit code, and their root forms over the local
 * disk's binding for the root they were given.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as answerManifest from "../../src/citations/answer-manifest.js";
import { CandidateCustodyUnavailableError } from "../../src/compiler/candidate-custody.js";
import {
  listCandidateIdentityPageFrom, listCandidatePage, listCandidatePageFrom, listCandidatesFrom, loadCandidateOrFail,
  loadCandidateOrFailFrom, loadCandidateUnderLockOrFailFrom, readCandidateFrom,
} from "../../src/compiler/candidate-read.js";
import { UnsafeCandidateDirError } from "../../src/compiler/candidate-store-paths.js";
import type { LocalEntry } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import * as diskRecordDirs from "../../src/storage/disk-local-record-dirs.js";
import { withQuiet } from "../../src/utils/output.js";
import { captureStatusLines } from "./project-tree.js";

const QUEUE = ".llmwiki/candidates";

/** One listed entry and, for a readable leaf, its text or the error its read rejects with. */
interface MemoryEntry extends LocalEntry {
  text?: string;
  readError?: NodeJS.ErrnoException;
}

/** How the double should misbehave, when a case needs it to. */
interface MemoryFaults {
  unresolvableLeaf?: string;
  unlistable?: boolean;
}

/** A record-directory binding over an in-memory listing, in exactly the order given. */
function memoryDirs(entries: MemoryEntry[] | null, faults: MemoryFaults = {}): LegacyLocalRecordDirs {
  return {
    directory: async (relDir) => (relDir !== QUEUE || entries === null ? null : {
      exists: async () => true,
      listEntries: async () => {
        if (faults.unlistable) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return entries.map(({ name, kind }) => ({ name, kind }));
      },
    }),
    leaf: async (_relDir, fileName) => {
      if (fileName === faults.unresolvableLeaf) throw new UnsafeCandidateDirError();
      const entry = entries?.find((listed) => listed.name === fileName);
      return {
        location: `memory:${QUEUE}/${fileName}`,
        readText: async () => {
          if (entry?.readError) throw entry.readError;
          if (entry?.text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return entry.text;
        },
      };
    },
  };
}

/** A regular candidate leaf holding a valid record. */
function record(id: string, generatedAt: string): MemoryEntry {
  const candidate = { id, title: `Title ${id}`, slug: id, summary: "s", sources: ["a.md"], body: `Body ${id}`, generatedAt };
  return { name: `${id}.json`, kind: "file", text: JSON.stringify(candidate, null, 2) };
}

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

/** The ids of the tolerant list over `entries`. */
async function listedIds(entries: MemoryEntry[] | null, faults?: MemoryFaults): Promise<string[]> {
  return (await withQuiet(() => listCandidatesFrom(memoryDirs(entries, faults)))).map((candidate) => candidate.id);
}

describe("tolerant candidate list over a memory record-directory binding", () => {
  it("reads only regular .json leaves and skips unparseable and malformed records", async () => {
    const entries: MemoryEntry[] = [
      record("good", T1),
      { name: "notes.txt", kind: "file", text: "not a candidate" },
      { name: "archive", kind: "directory" },
      { name: "dir.json", kind: "directory" },
      { name: "linked.json", kind: "link", text: record("linked", T1).text },
      { name: "broken.json", kind: "file", text: "{ not json" },
      { name: "partial.json", kind: "file", text: JSON.stringify({ id: "partial", title: "no slug" }) },
    ];
    expect(await listedIds(entries)).toEqual(["good"]);
  });

  it("orders by generation time only: equal times keep the listing order, with no id tie-break", async () => {
    expect(await listedIds([record("zeta", T2), record("mid", T1), record("alpha", T2), record("beta", T1)]))
      .toEqual(["mid", "beta", "zeta", "alpha"]);
    expect(await listedIds([record("alpha", T2), record("beta", T1), record("zeta", T2), record("mid", T1)]))
      .toEqual(["beta", "mid", "alpha", "zeta"]);
  });

  it("lists nothing for an absent directory and reports an unlistable one as custody unavailable", async () => {
    expect(await listedIds(null)).toEqual([]);
    await expect(listedIds([record("good", T1)], { unlistable: true })).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  });

  it("propagates a failed leaf resolution instead of treating it as a missing candidate", async () => {
    const entries = [record("good", T1), record("unsafe", T1)];
    await expect(listedIds(entries, { unresolvableLeaf: "unsafe.json" })).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    await expect(readCandidateFrom(memoryDirs(entries, { unresolvableLeaf: "unsafe.json" }), "unsafe"))
      .rejects.toBeInstanceOf(UnsafeCandidateDirError);
  });
});

describe("targeted candidate read and identity page over a memory record-directory binding", () => {
  const denied = Object.assign(new Error("EACCES"), { code: "EACCES" });
  const entries: MemoryEntry[] = [record("good", T1), { name: "denied.json", kind: "file", readError: denied }];

  it("treats a failed read as absent when tolerant, and rethrows all but ENOENT when strict", async () => {
    const dirs = memoryDirs(entries);
    expect((await readCandidateFrom(dirs, "good"))?.body).toBe("Body good");
    expect(await readCandidateFrom(dirs, "denied")).toBeNull();
    expect(await readCandidateFrom(dirs, "missing")).toBeNull();
    expect(await readCandidateFrom(dirs, "missing", { strictIo: true })).toBeNull();
    await expect(readCandidateFrom(dirs, "denied", { strictIo: true })).rejects.toBe(denied);
  });

  it("pages ids in UTF-16 code-unit order and subtracts only the unreadable ids it served", async () => {
    const queue = [record("b", T1), record("a", T2), record("Z", T2), { name: "c.json", kind: "file", readError: denied } as MemoryEntry];
    const page = await withQuiet(() => listCandidateIdentityPageFrom(memoryDirs(queue), 2));
    expect(page.entries.map((entry) => entry.fileId)).toEqual(["Z", "a"]);
    expect(page.total).toBe(4);
    const whole = await withQuiet(() => listCandidateIdentityPageFrom(memoryDirs(queue), 10));
    expect([whole.entries.map((entry) => entry.fileId), whole.total]).toEqual([["Z", "a", "b"], 3]);
  });
});

describe("the targeted loads and the bounded page over the same binding", () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
  /** Every status line a load prints, ANSI-stripped. */
  const errorsOf = () => {
    const lines: string[] = [];
    captureStatusLines(lines);
    return lines;
  };

  it("T1 a present candidate loads silently; an absent one prints its own line per caller and sets exit code 1", async () => {
    const lines = errorsOf();
    const dirs = memoryDirs([record("a", T1)]);
    expect([(await loadCandidateOrFailFrom(dirs, "a"))?.id, lines, process.exitCode ?? 0]).toEqual(["a", [], 0]);
    expect(await loadCandidateOrFailFrom(dirs, "gone")).toBeNull();
    expect(await loadCandidateUnderLockOrFailFrom(dirs, "gone")).toBeNull();
    expect([lines, process.exitCode]).toEqual([["! Candidate not found: gone", "! Candidate gone was removed by another process during review."], 1]);
  });

  it("T2 invalid answer metadata is reported as itself, not as a missing candidate; any other fault propagates", async () => {
    const lines = errorsOf();
    vi.spyOn(answerManifest, "assertAnswerCandidateMetadata").mockImplementation(() => { throw new answerManifest.InvalidCandidateMetadataError("a", "bad"); });
    expect(await loadCandidateOrFailFrom(memoryDirs([record("a", T1)]), "a")).toBeNull();
    expect(lines).toEqual(["! InvalidCandidateMetadata: a: bad"]);
    await expect(loadCandidateOrFailFrom(memoryDirs([record("a", T1)], { unresolvableLeaf: "a.json" }), "a")).rejects.toThrow();
  });

  it("T3 the page is the identity page's candidates and total; the root forms read the local disk's binding for their root", async () => {
    const dirs = memoryDirs([record("b", T1), record("a", T2)]);
    const page = await listCandidatePageFrom(dirs, 1);
    expect([page.candidates.map((candidate) => candidate.id), page.total]).toEqual([["a"], 2]);
    const disk = vi.spyOn(diskRecordDirs, "diskLocalRecordDirs").mockReturnValue(dirs);
    expect((await listCandidatePage("/project", 1)).total).toBe(2);
    expect((await loadCandidateOrFail("/project", "b"))?.id).toBe("b");
    expect(disk.mock.calls).toEqual([["/project"], ["/project"]]);
  });
});
