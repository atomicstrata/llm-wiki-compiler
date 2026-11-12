/**
 * @file test/storage/compile-memory-steps.ts
 * @description TEST-ONLY bound compositions of compile's accepted bodies over ONE
 * live in-memory project: the raw journal, page and lock I/O, the legacy reads,
 * records and candidate directories, the compile page-write, orphan and
 * finalize steps, and the whole compile run's {@link CompileRunSteps}. This is
 * the ONLY home of the bound composition: no production module builds it (the
 * production default is `localCompileRunSteps`, the incumbent root forms).
 *
 * Shared by `compile-orphan-binding`, `compile-finalize-binding` and
 * `compile-run-binding`, each of which asserts its own behaviour; nothing here
 * asserts. Logging is opt-in (`log`), so a witness that never asked for a trace
 * sees exactly the doubles it saw before this module existed.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The map's answers (an absent page is
 * simply `escapes-dir`; a realpath is the normalised spelling; no link is
 * followed), the lock host (pid 4242 self, 4343 a live foreign holder, a fake
 * clock), the gate's four DOMAIN legs (labelled FAKES; root-bound in
 * production, their per-leg rulings OPEN), the compile records' candidate
 * queue (a collecting double, not a composed candidate body), the embeddings
 * recorder, and every injected fault. Nothing here shows real confinement, the
 * lock's physical exclusivity, fsync or hosted behaviour.
 */

import path from "node:path";
import { localCompileAccess, type CompileAccess, type CompileRecords } from "../../src/compiler/compile-access.js";
import { finalizeUnchangedCompileWith, seedThenFinalizeWith, type CompileFinalizeSteps } from "../../src/compiler/compile-finalize.js";
import { logCompileWith } from "../../src/compiler/compile-report.js";
import { CompileStateDraft } from "../../src/compiler/compile-state-draft.js";
import { applyCompilePageWritesWith, type CompilePageWriteSteps } from "../../src/compiler/compile-write.js";
import type { CandidateDraft } from "../../src/compiler/candidates.js";
import { readWikiPageContentOrWarnFrom, warnDroppedReadIfPresentFrom } from "../../src/compiler/confined-wiki-read.js";
import type { CompileRunSteps } from "../../src/compiler/index.js";
import { collectPageSummariesFrom, generateIndexFrom } from "../../src/compiler/indexgen.js";
import { repairLinksFrom } from "../../src/compiler/link-repair.js";
import { generateMOCFrom } from "../../src/compiler/obsidian.js";
import { markOrphanedWith, orphanUnownedFrozenPagesWith, type OrphanPassSteps } from "../../src/compiler/orphan.js";
import { resolveLinksFrom } from "../../src/compiler/resolver.js";
import { generateSeedPagesWith, type SeedPageSteps } from "../../src/compiler/seed-pages.js";
import { acquireMutationLockWith, type RecoveryGateSteps } from "../../src/operation-bundles/lock-gate.js";
import type { LegacyLocalReads, LocalEntry } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";
import { applyApprovedMutationsLockedFrom, type ApprovedMutationPorts, type WriteOne } from "../../src/trust/executor.js";
import { recoverJournalBeforeCompileFrom } from "../../src/trust/journal-recovery.js";
import { planPageMutationFrom } from "../../src/trust/planner.js";
import { appendLogWith } from "../../src/utils/activity-log.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write-no-replace-durable.js";
import { CONCEPTS_DIR, INDEX_FILE, MOC_FILE, QUERIES_DIR } from "../../src/utils/constants.js";
import { callClaude } from "../../src/utils/llm.js";
import { acquireLockBlockingFrom, acquireLockFrom, releaseLockFrom, type LockHost, type LockIo } from "../../src/utils/lock.js";
import type { ReviewCandidate } from "../../src/utils/types.js";
import { cappedHeldText } from "./copied-project.js";

/** The memory project's root; every absolute path is under it. */
export const MEM_ROOT = path.resolve("/memory/project");

/** The live memory project: files and directories as POSIX keys under {@link MEM_ROOT}, plus any links a copy listed. */
export interface Held { files: Map<string, string>; dirs: Set<string>; links?: Set<string> }

/** The POSIX key of `abs` under {@link MEM_ROOT}. */
export const keyOf = (abs: string): string => path.relative(MEM_ROOT, abs).split(path.sep).join("/");
const enoent = (): Error => Object.assign(new Error("ENOENT: not held"), { code: "ENOENT" });
/** A member this composition never expects to be asked. */
const unasked = (name: string) => async (): Promise<never> => { throw new Error(`${name} not asked`); };

/** Hold `text` at project-relative `rel`, adding every parent directory. */
export function put(held: Held, rel: string, text: string): void {
  held.files.set(rel, text);
  for (let dir = path.posix.dirname(rel); dir !== "."; dir = path.posix.dirname(dir)) held.dirs.add(dir);
}

/** The direct child names of project-relative `dir` (files and directories), sorted. */
export const namesIn = (held: Held, dir: string): string[] =>
  [...new Set([...held.files.keys(), ...held.dirs].filter((rel) => rel.startsWith(`${dir}/`)).map((rel) => rel.slice(dir.length + 1).split("/")[0]!))].sort();
const batchKey = (abs: string): string => keyOf(abs).replace(/[^/]+\.json$/u, "<batch>.json");

/** Raw journal and page I/O over the map (no links: a realpath is the normalised spelling); journal and page calls logged only into `log`. */
export function memoryIo(held: Held, log?: string[]): ApprovedMutationPorts["journal"] & ApprovedMutationPorts["page"] {
  const exists = (abs: string): boolean => keyOf(abs) === "" || held.dirs.has(keyOf(abs)) || held.files.has(keyOf(abs));
  return {
    confineTarget: async (target, root) => { log?.push(`confine ${target}`); return path.resolve(root, target); },
    realPath: async (location) => { if (!exists(location)) throw enoent(); return path.resolve(location); },
    safeRealPath: async (location) => { log?.push(`safe-realpath ${keyOf(location)}`); return exists(location) ? path.resolve(location) : null; },
    leafPresent: async (dir, name) => held.files.has(keyOf(path.join(dir, name))),
    readConfinedLeafText: async (_root: string, leaf: string, _dir: string, maxBytes: number) => cappedHeldText(held.files.get(keyOf(leaf)), maxBytes),
    readConfinedLeafBytes: unasked("readConfinedLeafBytes"),
    readLeafTextNoFollow: async (leaf) => held.files.get(keyOf(leaf)) ?? null,
    replaceLeafAtomicWithin: async (_root, leaf, text) => { log?.push(`journal ${batchKey(leaf)}`); put(held, keyOf(leaf), text); },
    replaceLeafContentWithin: async (_root, leaf, content) => { log?.push(`restore ${keyOf(leaf)}`); put(held, keyOf(leaf), String(content)); },
    removeLeaf: async (leaf) => { log?.push(`remove ${batchKey(leaf)}`); if (!held.files.delete(keyOf(leaf))) throw enoent(); },
    listDirectoryNames: async (dir) => namesIn(held, keyOf(dir)),
    makeDirectoryTree: async (dir) => { held.dirs.add(keyOf(dir)); },
    renameLeafUnguarded: unasked("renameLeafUnguarded"),
  };
}

/** The kind of a held project-relative path, or ENOENT. */
function kindOf(held: Held, rel: string): LocalEntry["kind"] {
  if (held.files.has(rel)) return "file";
  if (held.links?.has(rel)) return "link";
  if (held.dirs.has(rel)) return "directory";
  throw enoent();
}

/** The legacy reads, records and empty candidate directories over the live map. */
export function memoryStores(held: Held): { reads: LegacyLocalReads; records: LegacyLocalRecords; candidates: LegacyLocalRecordDirs } {
  const listed = (dir: string): string[] => { if (!held.dirs.has(dir)) throw enoent(); return namesIn(held, dir); };
  const confined = (rel: string) => { const text = held.files.get(rel); return text === undefined ? { dropped: "escapes-dir" } : { content: text }; };
  const reads: LegacyLocalReads = {
    readText: async (rel) => { const text = held.files.get(rel); if (text === undefined) throw enoent(); return text; },
    exists: async (rel) => held.files.has(rel) || held.dirs.has(rel),
    statNoFollow: async (rel) => kindOf(held, rel),
    listNames: async (rel) => listed(rel),
    realDirectory: async (dir) => (held.dirs.has(dir) ? {
      listEntries: async (relative) => { const at = relative ? `${dir}/${relative}` : dir; return listed(at).map((name) => ({ name, kind: kindOf(held, `${at}/${name}`) })); },
    } : null),
    readConfinedPage: async (relDir, slug) => confined(`${relDir}/${slug}.md`),
    readConfinedFile: async (rel) => confined(rel),
    locate: (rel) => `memory:${rel}`,
  };
  const records: LegacyLocalRecords = {
    exists: async (rel) => held.files.has(rel),
    readTextNoFollow: async (rel) => { const text = held.files.get(rel); if (text === undefined) throw enoent(); return text; },
    copy: unasked("records.copy"), writeAtomic: async (rel, text) => { put(held, rel, text); }, locate: (rel) => `memory:${rel}`,
  };
  return { reads, records, candidates: { directory: async () => null, leaf: unasked("candidates.leaf") } };
}

/** The held-lock executor ports and the compile page-write steps over the map; `write`/`note` logged only into `log`. */
export function memoryPorts(held: Held, opts: { log?: string[]; writeOne?: WriteOne } = {}): { io: ReturnType<typeof memoryIo>; ports: ApprovedMutationPorts; write: CompilePageWriteSteps } {
  const io = memoryIo(held, opts.log);
  const write$: WriteOne = async (filePath, content) => { opts.log?.push(`write ${keyOf(filePath)}`); put(held, keyOf(filePath), content); };
  const fail = unasked("non-page handler");
  const ports: ApprovedMutationPorts = {
    journal: io, page: io, writeOne: opts.writeOne ?? write$, notes: (m) => { opts.log?.push(`note ${m}`); },
    handlers: { relation: fail, lifecycle: fail, artifact: fail },
  };
  const write: CompilePageWriteSteps = { plan: (input) => planPageMutationFrom(io, input), apply: (root, planned) => applyApprovedMutationsLockedFrom(ports, root, planned) };
  return { io, ports, write };
}

/** The orphan pass's steps: a memory page read, the REAL dropped-read warning over `reads`, the bound compile write. */
export function memoryOrphanSteps(held: Held, reads: LegacyLocalReads, write: CompilePageWriteSteps): OrphanPassSteps {
  return {
    readPage: async (_root, relDir, slug) => { const text = held.files.get(`${relDir}/${slug}.md`); return text === undefined ? { dropped: "escapes-dir" } : { content: text }; },
    warnDropped: (_absPath, relPath, reason) => warnDroppedReadIfPresentFrom(reads, relPath, relPath, reason),
    writePages: (root, writes) => applyCompilePageWritesWith(write, root, writes),
  };
}

/** How the finalize steps are told apart: the seed provider, the step trace, a resolution fault, the frozen-orphan step. */
export interface FinalizeOptions {
  complete: SeedPageSteps["complete"];
  log?: string[];
  faults?: { resolve?: Error };
  orphanFrozen?: CompileFinalizeSteps["orphanFrozen"];
}

/** Every tail step bound to the live map: the real bodies, the given seed provider, and an embeddings recorder. */
export function memoryFinalizeSteps(held: Held, write: CompilePageWriteSteps, opts: FinalizeOptions): CompileFinalizeSteps {
  const { reads, records, candidates } = memoryStores(held);
  const scan = (dir: string) => ({ listNames: () => reads.listNames(dir), readPage: (slug: string) => reads.readConfinedPage(dir, slug) });
  const seed: SeedPageSteps = { complete: opts.complete, readPage: (_root, relDir, slug, warnAlways) => readWikiPageContentOrWarnFrom(reads, relDir, slug, warnAlways), writePages: (root, writes) => applyCompilePageWritesWith(write, root, writes) };
  const step = <T>(name: string, run: () => Promise<T>): Promise<T> => { opts.log?.push(name); return run(); };
  return {
    seedPages: (root, schema, gen) => step("seed", () => generateSeedPagesWith(seed, root, schema, gen)),
    orphanFrozen: opts.orphanFrozen ?? unasked("orphanFrozen"),
    resolveLinks: (root, changed, created) => step("resolve", async () => { if (opts.faults?.resolve) throw opts.faults.resolve; return applyCompilePageWritesWith(write, root, await resolveLinksFrom(reads, changed, created)); }),
    repairLinks: (root) => step("repair", async () => applyCompilePageWritesWith(write, root, await repairLinksFrom({ pages: reads, candidates }))),
    flushState: (_root, draft) => step("flush", () => draft.flushTo(records)),
    generateIndex: () => step("index", () => generateIndexFrom({
      conceptSummaries: () => collectPageSummariesFrom(scan(CONCEPTS_DIR)), querySummaries: () => collectPageSummariesFrom(scan(QUERIES_DIR)),
      loadProfile: async () => undefined, collectEntityPages: unasked("collectEntityPages"), publishIndex: async (text) => { put(held, INDEX_FILE, text); },
    })),
    generateMOC: () => step("moc", () => generateMOCFrom({ listConceptNames: () => reads.listNames(CONCEPTS_DIR), readConceptPage: (slug) => reads.readConfinedPage(CONCEPTS_DIR, slug), publishMoc: async (text) => { put(held, MOC_FILE, text); } })),
    refreshEmbeddings: (_root, ids) => step(`embeddings ${ids.join(",")}`, async () => {}),
  };
}

/** A test lock host: this process is pid 4242, pid 4343 is a live foreign holder, a fake clock, a one-holder FIFO. */
export function memoryHost(): LockHost {
  const clock = { now: 0 };
  const parked = new Map<string, () => void>();
  let drawn = 0;
  return {
    processId: () => 4242, serializeOwner: (pid) => JSON.stringify({ pid }),
    isOwnerProcessStale: (owner) => ![4242, 4343].includes(owner.pid),
    entropy: (bytes) => { drawn += 1; return drawn.toString(16).padStart(bytes * 2, "0"); },
    now: () => clock.now, sleep: async (ms) => { clock.now += ms; },
    admit: async () => () => {}, park: (key, release) => { parked.set(key, release); },
    releaseParked: (key) => { parked.get(key)?.(); parked.delete(key); },
    hasParked: () => parked.size > 0, status: () => {},
  };
}

/** The ordinary gate over the map: the REAL lock and journal-recovery bodies plus the four DOMAIN legs as labelled FAKES, each logged. */
function memoryGateSteps(held: Held, log: string[]): RecoveryGateSteps {
  const io = memoryIo(held);
  const lockIo: LockIo = {
    ...io,
    probeEntryNoFollow: async (location) => { if (keyOf(location) !== "" && !held.dirs.has(keyOf(location)) && !held.files.has(keyOf(location))) throw enoent(); },
    readLeafCapped: async (leaf) => { const text = held.files.get(keyOf(leaf)); return text === undefined ? { kind: "absent" as const } : { kind: "ok" as const, body: text }; },
    createLeafExclusive: async (leaf, text) => { if (held.files.has(keyOf(leaf))) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); put(held, keyOf(leaf), text); },
    linkLeafNoReplace: async (from, to) => { if (held.files.has(keyOf(to))) throw new AtomicWriteCollisionError(); put(held, keyOf(to), held.files.get(keyOf(from))!); },
  };
  const host = memoryHost();
  return {
    acquireLock: (root, options) => { log.push("lock"); return acquireLockFrom(lockIo, host, root, options); },
    acquireLockBlocking: (root, options) => { log.push("lock-blocking"); return acquireLockBlockingFrom(lockIo, host, root, options); },
    releaseLock: (root) => { log.push("release"); return releaseLockFrom(lockIo, host, root); },
    recoverJournal: (root) => { log.push("journal"); return recoverJournalBeforeCompileFrom(io, root); },
    detectBundleRecovery: async () => { log.push("bundle"); return null; },
    portableBlock: async () => { log.push("portable"); return null; },
    gateLifecycle: async (_root, intent) => { log.push(`lifecycle ${intent}`); return null; },
    settleHandoffs: async () => { log.push("settle"); },
  };
}

/** The compile records as DOUBLES: state through the draft's `loadFrom`, an empty pending queue, a collecting candidate queue. */
function memoryCompileRecords(records: LegacyLocalRecords, queue: CandidateQueue): CompileRecords {
  return {
    readState: async () => (await CompileStateDraft.loadFrom(records)).read(),
    pendingSourceStates: async () => new Map(),
    emitCandidate: async (draft): Promise<ReviewCandidate> => {
      queue.drafts.push(draft);
      return { ...draft, id: `${draft.slug}-memory`, generatedAt: "fixed", reviewMode: draft.reviewMode ?? "forced", heldReasons: draft.heldReasons ?? [] };
    },
    discardCandidatesForSlug: async (slug) => { queue.discarded.push(slug); },
  };
}

/** What the collecting candidate double received. */
export interface CandidateQueue { drafts: CandidateDraft[]; discarded: string[] }
/** Labelled memory faults for one compile run. */
export interface CompileRunFaults { compileRecovery?: "unsafe"; logAppend?: Error }

/** The WHOLE compile run's steps bound to the map, every step logged; the provider stays the host's (`callClaude`). */
export function memoryCompileRunSteps(held: Held, log: string[], faults: CompileRunFaults = {}): { steps: CompileRunSteps; queue: CandidateQueue; access: () => CompileAccess } {
  const gate = memoryGateSteps(held, log);
  const { io, write } = memoryPorts(held);
  const { reads, records } = memoryStores(held);
  const queue: CandidateQueue = { drafts: [], discarded: [] };
  const access = (): CompileAccess => localCompileAccess(reads, memoryCompileRecords(records, queue));
  const orphan = memoryOrphanSteps(held, reads, write);
  const orphanFrozen: CompileFinalizeSteps["orphanFrozen"] = (root, draft, slugs) => orphanUnownedFrozenPagesWith(orphan, root, draft, slugs);
  const finalize = memoryFinalizeSteps(held, write, { complete: (request) => callClaude(request), log, orphanFrozen });
  const appendText = async (rel: string, text: string): Promise<void> => { if (faults.logAppend) throw faults.logAppend; put(held, rel, (held.files.get(rel) ?? "") + text); };
  const step = <T>(name: string, run: () => Promise<T>): Promise<T> => { log.push(name); return run(); };
  const steps: CompileRunSteps = {
    acquire: (root) => acquireMutationLockWith(gate, root, "ordinary"),
    release: (root) => gate.releaseLock(root),
    recoverJournal: (root) => step("recover", async () => (faults.compileRecovery === "unsafe" ? { status: "unsafe" as const } : recoverJournalBeforeCompileFrom(io, root))),
    access: () => { log.push("access"); return access(); },
    loadDraft: () => step("draft", () => CompileStateDraft.loadFrom(records)),
    commitLive: (root, items) => step("commit-live", () => applyCompilePageWritesWith(write, root, items)),
    markOrphaned: (root, file, draft) => step(`orphan ${file}`, () => markOrphanedWith(orphan, root, file, draft)),
    orphanFrozen: (root, draft, slugs) => step("orphan-frozen", () => orphanFrozen(root, draft, slugs)),
    seedThenFinalize: (root, schema, gen, options, draft) => step("finalize", () => seedThenFinalizeWith(finalize, root, schema, gen, options, draft)),
    finalizeUnchanged: (root, draft, prep, options) => step("finalize-unchanged", () => finalizeUnchangedCompileWith(finalize, root, draft, prep, options)),
    listPageNames: (_root, dir) => step(`list ${dir}`, () => reads.listNames(dir)),
    logCompile: (_root, buckets, gen, ids) => step("log", () => logCompileWith((op, text, o) => appendLogWith(appendText, op, text, o), buckets, gen, ids)),
  };
  return { steps, queue, access };
}
