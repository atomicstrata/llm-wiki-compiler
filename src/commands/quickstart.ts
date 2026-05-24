/**
 * `llmwiki quickstart <source>` — first-run wrapper that ingests a single
 * source then compiles it into a browsable wiki.
 *
 * Honours the JSON contract from the next-quickstart implementation plan:
 *   - `version: 1` envelope, incremented independently from `next`.
 *   - `--json` implies `--no-open` and never starts the foreground viewer.
 *     `viewer.opened` stays `false` and `viewer.url` stays `null` in JSON
 *     output, regardless of project state.
 *   - `--review` skips the viewer regardless of `--open` / `--no-open`.
 *   - `compile.ok` is true only when `compileAndReport()` returned and
 *     `CompileResult.errors` is empty. Returned errors land on
 *     `compile.errors` verbatim; thrown errors land on `compile.error`.
 *   - After ingest succeeds, `compile.pendingCandidates` is read from
 *     `countCandidates(root)` at exit so prior pending candidates show up
 *     even on compile failure paths. Ingest failures deliberately skip
 *     project inspection and report `pendingCandidates: 0`.
 *
 * Viewer handoff (Slice 3): in human mode only, when wiki pages exist and
 * none of `--no-open`, `--json`, or `--review` is set, the human summary
 * is emitted first, then `Starting viewer. Press Ctrl+C to stop.`, then
 * `viewCommand({ open: true })` takes over the foreground exactly like
 * `llmwiki view --open`. The viewer's own `Viewer ready at <url>` line
 * follows. Ctrl+C / SIGTERM are owned by viewCommand's shutdown handler.
 *
 * Provider credentials are validated AFTER ingest so a credential-free
 * ingest still preserves the source on disk before quickstart reports
 * the compile failure.
 */

import path from "path";
import { ingestSource } from "./ingest.js";
import viewCommand from "./view.js";
import { compileAndReport } from "../compiler/index.js";
import { countCandidates } from "../compiler/candidates.js";
import { collectProjectState } from "../project/state.js";
import type { ProjectState } from "../project/state.js";
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

/**
 * Viewer sub-envelope. Stays `{opened:false,url:null}` for the JSON path
 * because `--json` implies `--no-open`. The human-mode handoff prints
 * the viewer URL via viewCommand's own readiness line, after the
 * envelope has already been rendered to stdout.
 */
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
 * Build the static JSON-side viewer envelope. The handoff path prints
 * the live viewer URL via viewCommand's own readiness line; the JSON
 * field stays static because `--json` never starts the viewer.
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
 * quickstart, optionally hand off to the foreground viewer, and return
 * the appropriate exit code. Non-zero only when the failure isn't
 * already covered by the documented partial-success envelope (resumable
 * compile failures keep exit 0 so agents reading the JSON envelope
 * drive the recovery; ingest failures are the one exit-1 path and
 * finalize separately).
 */
async function finalizeSuccess(
  run: QuickstartRun,
  options: QuickstartOptions,
  jsonMode: boolean,
  root: string,
): Promise<number> {
  const projectState = await safeCollectState(root);
  const next = deriveNextAction(run, options, projectState);
  const handoff = shouldStartViewer({ options, jsonMode, compile: run.compile, projectState });
  const envelope = buildSuccessEnvelope(run, suppressRedundantViewerNext(next, handoff));
  emitEnvelope(envelope, jsonMode);
  if (handoff) await handoffToViewer();
  return 0;
}

/** Assemble the top-level success envelope from the per-section state. */
function buildSuccessEnvelope(run: QuickstartRun, next: NextEnvelope): QuickstartEnvelope {
  return {
    version: QUICKSTART_JSON_VERSION,
    source: run.source,
    ingest: run.ingest,
    compile: run.compile,
    viewer: run.viewer,
    next,
  };
}

/**
 * Collect the post-compile project state cheaply, returning null on
 * inspection failure so handoff and recommendation fall back to their
 * conservative defaults rather than throwing the whole quickstart.
 */
async function safeCollectState(root: string): Promise<ProjectState | null> {
  try {
    return await collectProjectState(root);
  } catch {
    return null;
  }
}

/** Pick the per-scenario next-action recommendation using already-collected state. */
function deriveNextAction(
  run: QuickstartRun,
  options: QuickstartOptions,
  projectState: ProjectState | null,
): NextEnvelope {
  if (options.review === true && run.compile.ok) return reviewListAction();
  if (!run.compile.ok) return resumeCompileAction(run.compile);
  return postCompileRecommendation(projectState);
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
 * when the post-compile state inspection itself failed earlier.
 */
function postCompileRecommendation(projectState: ProjectState | null): NextEnvelope {
  if (!projectState) {
    return {
      command: "llmwiki view --open",
      reason: "Wiki pages are ready to browse.",
      executable: { binary: "llmwiki", args: ["view", "--open"] },
    };
  }
  const { recommended } = recommendNextAction(projectState);
  return {
    command: recommended.command,
    reason: recommended.reason,
    executable: recommended.executable,
  };
}

/** Inputs for the viewer-handoff gate; grouped so the predicate stays one screen. */
interface HandoffGate {
  options: QuickstartOptions;
  jsonMode: boolean;
  compile: CompileEnvelope;
  projectState: ProjectState | null;
}

/**
 * Viewer Lifecycle start condition (plan §Viewer Lifecycle): wiki pages
 * exist, `--no-open` is false, `--json` is false, and `--review` is
 * false. Compile must also have completed cleanly — opening the viewer
 * on a compile-failure path would surface stale or partial wiki state
 * to the user.
 */
function shouldStartViewer(gate: HandoffGate): boolean {
  if (gate.jsonMode) return false;
  if (gate.options.open === false) return false;
  if (gate.options.review === true) return false;
  if (!gate.compile.ok) return false;
  if (!gate.projectState) return false;
  return gate.projectState.conceptCount + gate.projectState.queryCount > 0;
}

/**
 * Drop the `Next:` line ONLY when the recommendation is the redundant
 * `llmwiki view --open` action and the viewer is about to start —
 * printing it right above the handoff line would just echo the action
 * that's about to take over the foreground. Other recommendations
 * (e.g. `llmwiki lint` when a populated lint cache has errors,
 * `llmwiki review list` when candidates are pending) must survive
 * handoff so the user still sees the follow-up to run after Ctrl+C.
 * The JSON envelope is unaffected because handoff only happens in
 * human mode and `--json` always implies `--no-open`.
 */
function suppressRedundantViewerNext(next: NextEnvelope, handoff: boolean): NextEnvelope {
  if (!handoff) return next;
  if (!isViewOpenAction(next)) return next;
  return { command: null, reason: next.reason, executable: null };
}

/**
 * True when `next` is the literal `llmwiki view --open` action. Matches
 * on the executable arg shape rather than the display string so a
 * future cosmetic tweak to `command` doesn't silently break the
 * suppression invariant.
 */
function isViewOpenAction(next: NextEnvelope): boolean {
  const args = next.executable?.args;
  if (!Array.isArray(args) || args.length !== 2) return false;
  return args[0] === "view" && args[1] === "--open";
}

/**
 * Announce the foreground transition, then hand control to viewCommand.
 * viewCommand resolves once the HTTP server is bound; the listening
 * socket keeps the event loop alive until SIGINT/SIGTERM lands on
 * viewCommand's shutdown handler. Quickstart's own promise chain
 * unwinds normally — we never block past the await here in practice.
 */
async function handoffToViewer(): Promise<void> {
  process.stdout.write("\nStarting viewer. Press Ctrl+C to stop.\n");
  await viewCommand({ open: true });
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
