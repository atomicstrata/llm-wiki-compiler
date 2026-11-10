/**
 * @file test/storage/candidate-rejection-binding.test.ts
 * @description Raw candidate REJECTION, WHOLE: `loadRejectableCandidateOrFailFrom`
 * (the public-policy raw capture, or the shared not-found refusal) and
 * `archiveRejectedCandidateFrom` (the same capture, the caller's step on the
 * captured bytes OUTSIDE the move's `try`, the move bound to that receipt, and
 * the fixed refusal with exit code 1), over store mechanisms held in memory.
 * They exist only after the two consumers were given bodies of their own, so
 * this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Four default projects are minted on real disk, once. Each
 * holds a fresh record written by the real `writeFreshCandidate`, and the
 * archive projects also hold a malformed-JSON record and a record with
 * malformed validated-answer metadata, as raw bytes. Each project's OWN disk
 * ask snapshots `.llmwiki`, then runs its scenario's STEPS through the real
 * root forms. Each step is observed EXACTLY ONCE, and only there: its outcome
 * settled once (a value as its JSON, a refusal as its error name), its status
 * lines, and its exit code, with the output spy and `process.exitCode`
 * restored after every step. The minting directories are removed before any
 * case runs. The memory side runs the same steps through the bound bodies,
 * from the disk's own snapshot, and its files and directories are compared
 * with the copied post-operation tree.
 *
 * THE CALLER'S STEP. `beforeArchive` is the incumbent extension hook. Here it
 * records the exact bytes it is handed, throws, or rewrites the pending record
 * through the same physical store the scenario runs over. What the real
 * command's step does (the review intent and the embedding retry queue) is not
 * run here and stays root-bound.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: which directories exist and
 * their synthetic identities, a leaf's bytes and identity, whether a move's
 * source still matches its expectation, the rename, and a non-recursive
 * directory create. Two faults exist only in memory: a rename that throws and a
 * store that no longer re-proves. They have no disk twin here.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: links, FIFOs,
 * occupied archive identities, real access refusals, the open handle and the
 * act-by-path windows. Their regressions stay in the incumbent rejection
 * suites. The review lock and the `review reject` command are not run here.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import type { CandidateStoreMoveReads } from "../../src/compiler/candidate-custody.js";
import {
  archiveRejectedCandidate, archiveRejectedCandidateFrom, loadRejectableCandidateOrFail, loadRejectableCandidateOrFailFrom,
} from "../../src/compiler/candidate-rejection.js";
import { writeFreshCandidate } from "../../src/compiler/candidates.js";
import { CANDIDATES_ARCHIVE_DIR, LLMWIKI_DIR } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";
import { archivedRel, capturedDirectoryOf, heldLeavesOf, MEM_PROJECT, memoryRelOf, memoryStateOf, pendingRel, sequentialIdentity, snapshotTree, unaskedWriteLeaves, type Held, type Tree } from "./candidate-store-doubles.js";
import { mintCopied, writeFiles } from "./copied-project.js";
import { mintEachScenario } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-rejection-binding-";
const MALFORMED_JSON = "{\"id\": \"json-j\", \"title\": ";
const MALFORMED_METADATA = `${JSON.stringify({ id: "../untrusted", title: "Meta", slug: "meta", body: "b", sources: [],
  candidateKind: { name: "validated-answer", version: 99 } }, null, 2)}\n`;
const MISSING = "Candidate not found or removed during review: gone-x";
const REFUSED = "Candidate could not be archived safely.";

/** The two consumers, by root on disk or bound in memory, plus the physical rewrite a caller's step may make. */
interface Api {
  load(id: string): Promise<boolean>;
  archive(id: string, beforeArchive?: (bytes: Buffer) => Promise<void>): Promise<boolean>;
  rewrite(id: string, text: string): Promise<void>;
}
type Step = (api: Api, events: string[]) => Promise<unknown>;
/** One step, observed once: its settled outcome, its status lines, and its exit code. */
interface Observed { outcome: string; lines: string[]; exitCode: number }
interface OnDisk { before: Tree; observed: Observed[]; events: string[] }

/** A caller step that records the exact bytes it is handed, in order with every other event. */
const recording = (events: string[]) => async (bytes: Buffer) => { events.push(`step ${bytes.toString("base64")}`); };

const SCENARIOS = {
  load: { malformed: false,
    steps: [(api) => api.load("alpha-a"), (api) => api.load("gone-x"), (api) => api.load("../escape")] as Step[] },
  archive: { malformed: true,
    steps: [(api, events) => api.archive("json-j", recording(events)), (api, events) => api.archive("meta-m", recording(events)),
      (api) => api.load("meta-m"), (api, events) => api.archive("gone-x", recording(events)), (api) => api.archive("../escape")] as Step[] },
  stepThrows: { malformed: false,
    steps: [(api) => api.archive("alpha-a", async () => { throw new Error("step refused"); })] as Step[] },
  stepRewrites: { malformed: false,
    steps: [(api, events) => api.archive("alpha-a", async (bytes) => { await recording(events)(bytes); await api.rewrite("alpha-a", "{\"rewritten\":true}"); })] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Observe one step exactly once: settle its outcome once, capture its status lines and exit code, then restore both. */
async function observe(run: () => Promise<unknown>): Promise<Observed> {
  const lines: string[] = [];
  const status = vi.spyOn(output, "status").mockImplementation((icon, message) => { lines.push(`${icon} ${message}`); });
  const previous = process.exitCode;
  // Bun ignores assigning `undefined`, so 0 is the only reset that takes.
  process.exitCode = 0;
  try {
    const outcome = await run().then((value) => JSON.stringify(value), (error: Error) => error.name);
    return { outcome, lines, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    status.mockRestore();
    process.exitCode = previous ?? 0;
  }
}

/**
 * Run a scenario's steps in order, observing each once. `events` is the ONE
 * sink the caller's step records into; in memory the mechanisms record into the
 * same sink, so step, ensure and move events keep their real order.
 */
async function runSteps(name: Name, api: Api, events: string[] = []): Promise<{ observed: Observed[]; events: string[] }> {
  const observed: Observed[] = [];
  for (const step of SCENARIOS[name].steps) observed.push(await observe(() => step(api, events)));
  return { observed, events };
}

/** The real root forms over the project at `root`. */
function diskApi(root: string): Api {
  return {
    load: (id) => loadRejectableCandidateOrFail(root, id),
    archive: (id, beforeArchive) => archiveRejectedCandidate(root, id, beforeArchive),
    rewrite: (id, text) => writeFile(path.join(root, pendingRel(id)), text),
  };
}

/** Seed one project: a fresh record, and in the archive project the two raw malformed records. */
async function seed(root: string, malformed: boolean): Promise<void> {
  await writeFreshCandidate(root, { title: "alpha", slug: "alpha", summary: "", sources: [], body: "alpha body" }, { idForAttemptForTest: () => "alpha-a" });
  if (malformed) await writeFiles(root, { [pendingRel("json-j")]: MALFORMED_JSON, [pendingRel("meta-m")]: MALFORMED_METADATA });
}

const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) =>
  mintCopied<OnDisk>(tracker, PREFIX, (root) => seed(root, SCENARIOS[name].malformed), async (root) => {
    const before = await snapshotTree(root, "utf8");
    return { before, ...(await runSteps(name, diskApi(root))) };
  }));

/** Faults with no disk twin: the rename throws; the pending store no longer re-proves. */
interface Faults { moveThrows?: boolean; drifted?: boolean }

/** Move mechanisms over `held` and `dirs`; every directory create and rename is also recorded to `events`. */
function memoryStoreOf(held: Map<string, Held>, dirs: Set<string>, events: string[], faults: Faults = {}): CandidateStoreMoveReads {
  const unused = (member: string) => async (): Promise<never> => { throw new Error(`${member} is not part of rejection`); };
  return {
    captureDirectory: capturedDirectoryOf(dirs, sequentialIdentity()),
    directoryStillBound: async (binding) => !faults.drifted && dirs.has(memoryRelOf(binding.dir)),
    ...heldLeavesOf(held, dirs, (event) => { events.push(event); }, { capped: true, moveThrows: faults.moveThrows }),
    probeDirectory: unused("probeDirectory"), recordDirectory: () => { throw new Error("the listing is not part of rejection"); },
    ...unaskedWriteLeaves(unused),
  };
}

/** Run one scenario in memory from the disk's own snapshot; `MEM_PROJECT` fills only the move request's legacy field. */
async function inMemory(name: Name, faults: Faults = {}) {
  const before = minted[name]!.onDisk.before;
  const { held, dirs } = memoryStateOf(before, "utf8");
  const events: string[] = [];
  const reads = memoryStoreOf(held, dirs, events, faults);
  const api: Api = {
    load: (id) => loadRejectableCandidateOrFailFrom(reads, id),
    archive: (id, beforeArchive) => archiveRejectedCandidateFrom(reads, MEM_PROJECT, id, beforeArchive),
    rewrite: async (id, text) => { held.set(pendingRel(id), { ...held.get(pendingRel(id))!, bytes: Buffer.from(text, "utf8") }); },
  };
  const { observed } = await runSteps(name, api, events);
  const files = Object.fromEntries([...held].map(([rel, leaf]) => [rel, leaf.bytes.toString("utf8")]));
  return { observed, events, files, dirs: [...dirs].sort() };
}

/** Run `name` in memory and require the disk's observations, caller-step bytes, files and directories. */
async function expectDiskParity(name: Name) {
  const run = await inMemory(name);
  const onDisk = minted[name]!.onDisk;
  const copy = minted[name]!.copy;
  const under = (rel: string): boolean => rel === LLMWIKI_DIR || rel.startsWith(`${LLMWIKI_DIR}/`);
  expect([run.observed, run.events.filter((event) => event.startsWith("step"))]).toEqual([onDisk.observed, onDisk.events]);
  expect({ files: run.files, dirs: run.dirs }).toEqual({
    files: Object.fromEntries([...copy.files].filter(([rel]) => under(rel))), dirs: [...copy.listings.keys()].filter(under).sort() });
  return run;
}

const plainOf = (observed: Observed) => ({ ...observed, lines: observed.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) });
const stepOf = (name: Name, rel: string) => `step ${Buffer.from(minted[name]!.onDisk.before.files[rel]!, "utf8").toString("base64")}`;

describe("raw candidate rejection over copied default projects, with every minting directory gone", () => {
  it("R1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("R2 loads a present record, reports a missing one with exit 1, and refuses an unsafe id typed, as the disk did", async () => {
    const { observed } = await expectDiskParity("load");
    expect(observed.map(plainOf)).toEqual([{ outcome: "true", lines: [], exitCode: 0 },
      { outcome: "false", lines: [`! ${MISSING}`], exitCode: 1 }, { outcome: "UnsafeCandidateIdError", lines: [], exitCode: 0 }]);
  });

  it("R3 archives malformed-JSON and malformed-metadata records with their exact raw bytes, the step first, as the disk did", async () => {
    const { observed, events, files } = await expectDiskParity("archive");
    expect(observed.map((one) => one.outcome)).toEqual(["true", "true", "false", "false", "UnsafeCandidateIdError"]);
    expect([files[archivedRel("json-j")], files[archivedRel("meta-m")]]).toEqual([MALFORMED_JSON, MALFORMED_METADATA]);
    expect(events).toEqual([stepOf("archive", pendingRel("json-j")), `ensure ${CANDIDATES_ARCHIVE_DIR}`, `move ${pendingRel("json-j")} -> ${archivedRel("json-j")}`,
      stepOf("archive", pendingRel("meta-m")), `move ${pendingRel("meta-m")} -> ${archivedRel("meta-m")}`]);
  });

  it("R4 reports a record missing at load and at archive with the same line and exit 1, never calling the step", async () => {
    const { observed } = await expectDiskParity("archive");
    expect([plainOf(observed[2]!), plainOf(observed[3]!)]).toEqual([{ outcome: "false", lines: [`! Candidate not found or removed during review: meta-m`], exitCode: 1 },
      { outcome: "false", lines: [`! ${MISSING}`], exitCode: 1 }]);
    expect(observed[4]).toEqual({ outcome: "UnsafeCandidateIdError", lines: [], exitCode: 0 });
  });

  it("R5 refuses an unsafe id before any mechanism member is touched", async () => {
    const touched: string[] = [];
    const counted = new Proxy(memoryStoreOf(new Map(), new Set(), []), { get: (target, member) => { touched.push(String(member)); return Reflect.get(target, member); } });
    const load = await observe(() => loadRejectableCandidateOrFailFrom(counted, "../escape"));
    const archive = await observe(() => archiveRejectedCandidateFrom(counted, MEM_PROJECT, "../escape", async () => { touched.push("step"); }));
    expect([load.outcome, archive.outcome, touched]).toEqual(["UnsafeCandidateIdError", "UnsafeCandidateIdError", []]);
  });

  it("R6 lets a throwing step propagate, keeping the record pending with no archive diagnostic, as the disk did", async () => {
    const { observed, events, files } = await expectDiskParity("stepThrows");
    const before = minted.stepThrows!.onDisk.before.files[pendingRel("alpha-a")];
    expect([observed, events, files[pendingRel("alpha-a")], files[archivedRel("alpha-a")]]).toEqual([[{ outcome: "Error", lines: [], exitCode: 0 }], [], before, undefined]);
  });

  it("R7 refuses a record the step rewrote, keeping the rewritten bytes pending, with the fixed refusal and exit 1, as the disk did", async () => {
    const { observed, events, files } = await expectDiskParity("stepRewrites");
    expect([plainOf(observed[0]!), files[pendingRel("alpha-a")], files[archivedRel("alpha-a")]]).toEqual([
      { outcome: "false", lines: [`! ${REFUSED}`], exitCode: 1 }, "{\"rewritten\":true}", undefined]);
    expect(events).toEqual([stepOf("stepRewrites", pendingRel("alpha-a")), `ensure ${CANDIDATES_ARCHIVE_DIR}`]);
  });

  it("R8 maps a rename fault and a store that no longer re-proves to the fixed refusal, with no rename (memory only)", async () => {
    const before = minted.stepThrows!.onDisk.before;
    for (const faults of [{ moveThrows: true }, { drifted: true }]) {
      const held = new Map([[pendingRel("alpha-a"), { bytes: Buffer.from(before.files[pendingRel("alpha-a")]!, "utf8"), ino: 1 }]]);
      const events: string[] = [];
      const reads = memoryStoreOf(held, new Set(before.dirs), events, faults);
      const refused = await observe(() => archiveRejectedCandidateFrom(reads, MEM_PROJECT, "alpha-a"));
      expect([plainOf(refused), events, [...held.keys()]]).toEqual([{ outcome: "false", lines: [`! ${REFUSED}`], exitCode: 1 },
        [`ensure ${CANDIDATES_ARCHIVE_DIR}`], [pendingRel("alpha-a")]]);
    }
  });
});
