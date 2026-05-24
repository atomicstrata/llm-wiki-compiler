/**
 * `llmwiki quickstart <source>` — first-run wrapper that ingests a single
 * source then compiles it into a browsable wiki.
 *
 * Honours the JSON contract from the next-quickstart implementation plan:
 *   - `version: 1` envelope, incremented independently from `next`.
 *   - `--json` implies `--no-open` and the foreground viewer is never
 *     started. Slice 2 always reports `viewer.opened:false,url:null`;
 *     Slice 3 will replace this with a real foreground handoff.
 *   - `--review` skips the viewer regardless of `--open` / `--no-open`.
 *   - `compile.ok` is true only when `compileAndReport()` returned and
 *     `CompileResult.errors` is empty. Returned errors land on
 *     `compile.errors` verbatim; thrown errors land on `compile.error`.
 *   - After ingest succeeds, `compile.pendingCandidates` is read from
 *     `countCandidates(root)` at exit so prior pending candidates show up
 *     even on compile failure paths. Ingest failures deliberately skip
 *     project inspection and report `pendingCandidates: 0`.
 *
 * Provider credentials are validated AFTER ingest so a credential-free
 * ingest still preserves the source on disk before quickstart reports
 * the compile failure.
 */

import path from "path";
import { ingestSource } from "./ingest.js";
import { compileAndReport } from "../compiler/index.js";
import { countCandidates } from "../compiler/candidates.js";
import { collectProjectState } from "../project/state.js";
import { recommendNextAction } from "../project/recommendations.js";
import type { RecommendedAction } from "../project/recommendations.js";
import { ensureProviderAvailable } from "../utils/provider-guard.js";
import { applyLanguageOption } from "../utils/output-language.js";
import * as output from "../utils/output.js";
import { SOURCES_DIR } from "../utils/constants.js";
import type { CompileResult, IngestResult } from "../utils/types.js";

/** CLI-supplied options for `llmwiki quickstart`. */
export interface QuickstartOptions {
  /** Run compile in --review mode (candidates instead of wiki/ writes). */
  review?: boolean;
  /** When false, skip viewer handoff. Defaults to true via Commander's --no-open. */
  open?: boolean;
  /** Override LLMWIKI_PROVIDER for this process only. */
  provider?: string;
  /** Forwarded to applyLanguageOption before compile. */
  lang?: string;
  /** Emit the JSON envelope instead of human output (implies --no-open). */
  json?: boolean;
}

/** Versioned JSON envelope shape — incremented independently from `next`. */
const QUICKSTART_JSON_VERSION = 1;

/** Ingest sub-envelope. */
interface IngestEnvelope {
  ok: boolean;
  path: string | null;
  sourceType: string | null;
  error: ErrorEnvelope | null;
}

/** Compile sub-envelope. */
interface CompileEnvelope {
  ok: boolean;
  compiled: number;
  skipped: number;
  deleted: number;
  pendingCandidates: number;
  errors: string[] | null;
  error: ErrorEnvelope | null;
}

/** Common error shape used by both ingest and compile failure paths. */
interface ErrorEnvelope {
  code: string;
  message: string;
  recoverable: boolean;
}

/** Viewer sub-envelope. Slice 2 always reports `opened:false,url:null`. */
interface ViewerEnvelope {
  opened: boolean;
  url: string | null;
}

/** Next-action sub-envelope. Reuses Slice 1's recommendation shape. */
interface NextEnvelope {
  command: string | null;
  reason: string;
  executable: RecommendedAction["executable"];
}

/** Full top-level envelope. */
interface QuickstartEnvelope {
  version: number;
  source: string;
  ingest: IngestEnvelope;
  compile: CompileEnvelope;
  viewer: ViewerEnvelope;
  next: NextEnvelope;
}

/** Outcome aggregator carried through the pipeline before rendering. */
interface QuickstartRun {
  source: string;
  ingest: IngestEnvelope;
  compile: CompileEnvelope;
  viewer: ViewerEnvelope;
}

/**
 * Execute the quickstart pipeline. Returns the exit code the CLI shim
 * should propagate (0 for full or partial-but-resumable success, 1 for
 * hard failures like ingest errors).
 *
 * Stdout quiet-mode and per-process env overrides (`--provider`, `--lang`)
 * are scoped to this call via paired finally blocks so callers that
 * reuse the same Node process — e.g. future in-process MCP composition
 * or test harnesses — do not see leaked state from a prior invocation.
 */
export default async function quickstartCommand(
  source: string,
  options: QuickstartOptions = {},
): Promise<number> {
  const jsonMode = options.json === true;
  output.setQuiet(jsonMode);
  const restoreEnv = applyEnvOverrides(options);
  try {
    return await runQuickstart(source, options, jsonMode);
  } finally {
    restoreEnv();
    output.setQuiet(false);
  }
}

/** Inner orchestrator wrapped by the quiet-mode + env lifecycle. */
async function runQuickstart(
  source: string,
  options: QuickstartOptions,
  jsonMode: boolean,
): Promise<number> {
  const root = process.cwd();
  const ingest = await runIngestStep(source);
  if (!ingest.ok) {
    return finalizeFailure({ source, ingest, jsonMode });
  }

  const compile = await runCompileStep(root, options.review === true);
  const viewer = buildViewerEnvelope();
  const run: QuickstartRun = { source, ingest, compile, viewer };
  return await finalizeSuccess(run, options, jsonMode, root);
}

/**
 * Apply `--provider` and `--lang` into the process env and return a
 * restorer that puts both back exactly as they were. We snapshot
 * `undefined` separately from `""` so a previously-unset variable is
 * unset again on restore (rather than turning into an empty string,
 * which downstream resolvers normalise differently).
 */
function applyEnvOverrides(options: QuickstartOptions): () => void {
  const restorers: Array<() => void> = [];
  if (options.provider && options.provider.trim().length > 0) {
    restorers.push(snapshotEnv("LLMWIKI_PROVIDER"));
    process.env.LLMWIKI_PROVIDER = options.provider.trim();
  }
  if (options.lang && options.lang.trim().length > 0) {
    restorers.push(snapshotEnv("LLMWIKI_OUTPUT_LANG"));
    applyLanguageOption(options.lang);
  }
  return () => {
    for (const restore of restorers) restore();
  };
}

/** Capture a single env var's current value (including absence) so it can be restored later. */
function snapshotEnv(name: string): () => void {
  const previous = process.env[name];
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

/** Run ingest and report the structured envelope; never throws. */
async function runIngestStep(source: string): Promise<IngestEnvelope> {
  output.header("llmwiki quickstart");
  output.status("*", output.info(`Ingesting ${source}`));
  try {
    const result = await ingestSource(source);
    const relPath = path.join(SOURCES_DIR, result.filename);
    output.status("+", output.success(`Ingested → ${relPath}`));
    return buildIngestSuccess(result, relPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.status("!", output.error(`Ingest failed: ${message}`));
    return buildIngestFailure(message);
  }
}

/** Build the ingest envelope for a successful ingest. */
function buildIngestSuccess(result: IngestResult, relPath: string): IngestEnvelope {
  return {
    ok: true,
    path: relPath,
    sourceType: result.sourceType ?? null,
    error: null,
  };
}

/** Build the ingest envelope for a thrown ingest failure. */
function buildIngestFailure(message: string): IngestEnvelope {
  return {
    ok: false,
    path: null,
    sourceType: null,
    error: { code: "ingest_failed", message, recoverable: false },
  };
}

/** Default zero-compile envelope used when compile never ran. */
function emptyCompileEnvelope(): CompileEnvelope {
  return {
    ok: false,
    compiled: 0,
    skipped: 0,
    deleted: 0,
    pendingCandidates: 0,
    errors: null,
    error: null,
  };
}

/** Error codes the compile sub-envelope uses. */
type CompileErrorCode = "provider_unavailable" | "compile_failed";

/** Human label for each compile-error code; used in the stderr-style status line. */
const COMPILE_ERROR_LABEL: Record<CompileErrorCode, string> = {
  provider_unavailable: "Compile prerequisite",
  compile_failed: "Compile",
};

/**
 * Translate a thrown failure (provider guard OR compile pipeline) into the
 * structured compile envelope. Reads the post-failure candidate count so
 * prior pending candidates still surface even on the failure path.
 */
async function buildCompileFailureEnvelope(
  root: string,
  code: CompileErrorCode,
  err: unknown,
): Promise<CompileEnvelope> {
  const message = err instanceof Error ? err.message : String(err);
  output.status("!", output.error(`${COMPILE_ERROR_LABEL[code]} failed: ${message}`));
  return {
    ...emptyCompileEnvelope(),
    pendingCandidates: await safeCountCandidates(root),
    error: { code, message, recoverable: true },
  };
}

/** Run compile after ingest. Translates throws into a structured envelope. */
async function runCompileStep(root: string, review: boolean): Promise<CompileEnvelope> {
  try {
    ensureProviderAvailable();
  } catch (err) {
    return await buildCompileFailureEnvelope(root, "provider_unavailable", err);
  }
  try {
    const result = await compileAndReport(root, { review });
    return await buildCompileEnvelopeFromResult(root, result);
  } catch (err) {
    return await buildCompileFailureEnvelope(root, "compile_failed", err);
  }
}

/**
 * Translate a returned {@link CompileResult} into the envelope.
 * `compile.ok` is true only when `errors` is empty; numeric counters are
 * preserved verbatim either way.
 */
async function buildCompileEnvelopeFromResult(
  root: string,
  result: CompileResult,
): Promise<CompileEnvelope> {
  const pendingCandidates = await safeCountCandidates(root);
  const hasErrors = result.errors.length > 0;
  return {
    ok: !hasErrors,
    compiled: result.compiled,
    skipped: result.skipped,
    deleted: result.deleted,
    pendingCandidates,
    errors: hasErrors ? [...result.errors] : [],
    error: null,
  };
}

/** Race-tolerant candidate count; returns 0 when the candidate dir is missing. */
async function safeCountCandidates(root: string): Promise<number> {
  try {
    return await countCandidates(root);
  } catch {
    return 0;
  }
}

/**
 * Slice 2 never starts the foreground viewer. Slice 3 will swap this for
 * a real handoff guarded by the `viewer start condition`:
 *   wikiPagesExist && !noOpen && !json && !review.
 */
function buildViewerEnvelope(): ViewerEnvelope {
  return { opened: false, url: null };
}

/** Inputs for the ingest-failure finalisation path. */
interface FailureContext {
  source: string;
  ingest: IngestEnvelope;
  jsonMode: boolean;
}

/**
 * Print or emit an envelope for an ingest failure and return exit code 1.
 *
 * Per the implementation plan: "Invalid/missing source exits 1 without
 * project inspection or mutation." So compile is left at its empty
 * default — we do NOT read `.llmwiki/candidates`, do not stat the root,
 * and do not run the post-compile recommendation engine. The next
 * action steers the user back to a manual `ingest` they can debug.
 */
function finalizeFailure(ctx: FailureContext): number {
  const compile: CompileEnvelope = emptyCompileEnvelope();
  const next: NextEnvelope = {
    command: `llmwiki ingest ${ctx.source}`,
    reason: "Source could not be ingested. Inspect the input and rerun ingest.",
    executable: { binary: "llmwiki", args: ["ingest"], placeholders: ["source"] },
  };
  const envelope: QuickstartEnvelope = {
    version: QUICKSTART_JSON_VERSION,
    source: ctx.source,
    ingest: ctx.ingest,
    compile,
    viewer: buildViewerEnvelope(),
    next,
  };
  emitEnvelope(envelope, ctx.jsonMode);
  return 1;
}

/**
 * Print or emit an envelope for a completed (or post-ingest failed)
 * quickstart and return the appropriate exit code. Non-zero only when
 * the failure isn't already covered by the documented partial-success
 * envelope (Slice 2 keeps exit 0 for resumable compile failures so
 * agents reading the JSON envelope drive the recovery; ingest failures
 * are the one exit-1 path and finalize separately).
 */
async function finalizeSuccess(
  run: QuickstartRun,
  options: QuickstartOptions,
  jsonMode: boolean,
  root: string,
): Promise<number> {
  const next = await deriveNextAction(run, options, root);
  const envelope: QuickstartEnvelope = {
    version: QUICKSTART_JSON_VERSION,
    source: run.source,
    ingest: run.ingest,
    compile: run.compile,
    viewer: run.viewer,
    next,
  };
  emitEnvelope(envelope, jsonMode);
  return 0;
}

/** Pick the per-scenario next-action recommendation. */
async function deriveNextAction(
  run: QuickstartRun,
  options: QuickstartOptions,
  root: string,
): Promise<NextEnvelope> {
  if (options.review === true && run.compile.ok) return reviewListAction();
  if (!run.compile.ok) return resumeCompileAction(run.compile);
  return await postCompileRecommendation(root);
}

/** Fixed recommendation for a successful `--review` run. */
function reviewListAction(): NextEnvelope {
  return {
    command: "llmwiki review list",
    reason: "Generated candidates are waiting for review.",
    executable: { binary: "llmwiki", args: ["review", "list"] },
  };
}

/**
 * Recommendation when compile failed (returned errors or threw). Reason
 * mirrors the documented partial-success guidance.
 */
function resumeCompileAction(compile: CompileEnvelope): NextEnvelope {
  const reason = compile.error
    ? "Source was ingested, but compile did not complete."
    : "Compile reported errors. Address them and rerun compile.";
  return {
    command: "llmwiki compile",
    reason,
    executable: { binary: "llmwiki", args: ["compile"] },
  };
}

/**
 * Use Slice 1's recommendation engine for the happy path so the trailing
 * `next` field stays consistent with what `llmwiki next` would report
 * from the same project state. Falls back to a static view-open hint
 * when the post-compile state inspection itself fails.
 */
async function postCompileRecommendation(root: string): Promise<NextEnvelope> {
  try {
    const state = await collectProjectState(root);
    const { recommended } = recommendNextAction(state);
    return {
      command: recommended.command,
      reason: recommended.reason,
      executable: recommended.executable,
    };
  } catch {
    return {
      command: "llmwiki view --open",
      reason: "Wiki pages are ready to browse.",
      executable: { binary: "llmwiki", args: ["view", "--open"] },
    };
  }
}

/** Emit the envelope as JSON or render a human summary depending on mode. */
function emitEnvelope(envelope: QuickstartEnvelope, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  renderHuman(envelope);
}

/** Human summary: short multi-line block keyed to the envelope contents. */
function renderHuman(envelope: QuickstartEnvelope): void {
  const lines: string[] = [];
  appendIngestLine(lines, envelope.ingest);
  appendCompileLines(lines, envelope.compile);
  appendNextLines(lines, envelope.next);
  process.stdout.write(`\n${lines.join("\n")}\n`);
}

/** Ingest summary line — success path or short failure note. */
function appendIngestLine(lines: string[], ingest: IngestEnvelope): void {
  if (ingest.ok && ingest.path) {
    lines.push(`1. Ingested source → ${ingest.path}`);
    return;
  }
  lines.push("1. Ingest failed — see error above.");
}

/** Compile summary lines — success counts, review-pending count, or failure note. */
function appendCompileLines(lines: string[], compile: CompileEnvelope): void {
  if (compile.error) {
    lines.push("2. Compile did not complete.");
    return;
  }
  if (compile.errors && compile.errors.length > 0) {
    lines.push(`2. Compile reported ${compile.errors.length} error(s).`);
    return;
  }
  if (compile.ok && compile.pendingCandidates > 0) {
    lines.push(`2. Compiled review candidates → ${compile.pendingCandidates} pending`);
    return;
  }
  if (compile.ok) {
    lines.push(`2. Compiled wiki → ${compile.compiled} new, ${compile.skipped} skipped`);
  }
}

/** Trailing "Next:" line so the user sees the recommended follow-up. */
function appendNextLines(lines: string[], next: NextEnvelope): void {
  if (!next.command) return;
  lines.push("");
  lines.push("Next:");
  lines.push(`  ${next.command}`);
}
