/**
 * @file Registers `compile`: compile sources/ into the wiki.
 *
 * Besides the incumbent flags, `compile` carries the batch flags of a project
 * whose segmented compile state is the authority (`--batch-size`,
 * `--restart`), `--no-embeddings`, and the read-only report of a batch run
 * (`--report <runId> [--cursor <c>]`). The report is served BEFORE the
 * expected-scale and provider credential checks: it reads only the run store
 * and calls no model. Otherwise the expected-scale check and the compile
 * body's own option routing refuse before any credential is asked for.
 *
 * A batch compile refuses `--no-pages-limit`, `--review` and an embeddings
 * refresh before any effect (`src/compiler/batch/driver.ts`); on an ordinary
 * project every incumbent flag behaves as it always has.
 */

import type { Command } from "commander";
import compileCommand from "@atomicstrata/llmwiki-core/modules/commands/compile";
import { addProviderOption, applyProviderOption, type ProviderOption } from "@atomicstrata/llmwiki-core/modules/cli/provider-option";
import { parseConcurrencyFlag } from "@atomicstrata/llmwiki-core/modules/compiler/concurrency";
import { applyLanguageOption } from "@atomicstrata/llmwiki-core/modules/utils/output-language";
import { applySourcesSectionOption } from "@atomicstrata/llmwiki-core/modules/utils/sources-section";
import { setVerbose } from "@atomicstrata/llmwiki-core/modules/utils/output";
import { assertCompileOptionsRoutable, assertScaleReady, compileReportCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { verboseEnabled } from "./verbose.js";
import { readInstructions } from "./instructions.js";
import { requireCompileProvider } from "./require-provider.js";

interface CompileOptions extends ProviderOption {
  review?: boolean;
  lang?: string;
  sourcesSection?: boolean;
  pagesLimit?: boolean;
  instructions?: string;
  concurrency?: string;
  verbose?: boolean;
  batchSize?: string;
  restart?: boolean;
  embeddings?: boolean;
  report?: string;
  cursor?: string;
}

/** The checks `compile` runs before work; injectable so a test can observe the credential guard. */
export interface CompileCommandDeps {
  /** The compile-aware provider credential guard (exits on failure); embedding credentials only when embeddings refresh. */
  requireCompileProvider(refreshEmbeddings?: boolean): void;
}

const DEFAULT_DEPS: CompileCommandDeps = { requireCompileProvider };

/** A strictly positive integer flag, or a refusal naming it. */
function parseBatchSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`--batch-size must be a positive integer (got ${value.slice(0, 40)})`);
  return Number(value);
}

/** The compile options of the parsed flags (the batch ones only when given). */
function compileOptionsOf(options: CompileOptions, systemPolicy: string | undefined): Parameters<typeof compileCommand>[0] {
  return {
    review: options.review, concurrency: parseConcurrencyFlag(options.concurrency), systemPolicy,
    noPagesLimit: options.pagesLimit === false,
    ...(options.embeddings === false ? { embeddings: false } : {}),
    ...(options.batchSize === undefined ? {} : { batchSize: parseBatchSize(options.batchSize) }),
    ...(options.restart ? { restart: true } : {}),
  };
}

/** Apply the flags that shape the run's environment, then the expected-scale check; returns the system policy. */
async function preparedEnvironment(options: CompileOptions): Promise<string | undefined> {
  applyProviderOption(options);
  setVerbose(verboseEnabled(options.verbose));
  applyLanguageOption(options.lang);
  applySourcesSectionOption(options.sourcesSection);
  const systemPolicy = await readInstructions(options.instructions);
  // A project blocked by its expected scale refuses before the provider check; the lock rechecks.
  await assertScaleReady(process.cwd());
  return systemPolicy;
}

/** Run one compile from the parsed flags (a report page needs no provider and checks nothing first). */
async function runCompile(options: CompileOptions, deps: CompileCommandDeps): Promise<void> {
  if (options.cursor !== undefined && options.report === undefined) throw new Error("--cursor applies only with --report <runId>");
  if (options.report !== undefined) return compileReportCommand(options.report, options.cursor);
  const systemPolicy = await preparedEnvironment(options);
  const compileOptions = compileOptionsOf(options, systemPolicy);
  // An option this project's compile body does not support refuses here, before any credential is asked for.
  await assertCompileOptionsRoutable(process.cwd(), compileOptions ?? {});
  deps.requireCompileProvider(options.embeddings !== false);
  await compileCommand(compileOptions);
}

/** Add every `compile` option, incumbent flags first, in help order. */
function addCompileOptions(command: Command): Command {
  return addProviderOption(command)
    .option("--no-pages-limit", "Remove the requested 3–8 concepts per source; allow source-supported results with no pages")
    .option("--instructions <path>", "Add UTF-8 project instructions for this compile (max 64 KiB); changing or omitting them recompiles affected pages")
    .option(
      "--review",
      "Write generated pages as review candidates under .llmwiki/candidates/ instead of mutating wiki/. Orphan-marking for deleted sources is deferred until the next non-review compile.",
    )
    .option(
      "--lang <code>",
      "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
    )
    .option(
      "--no-sources-section",
      "Stop requesting a trailing ## Sources section; changing this preference recompiles affected pages. Equivalent to LLMWIKI_SOURCES_SECTION=off; unset it and omit this flag to restore the default.",
    )
    .option(
      "--concurrency <n>",
      "Max concurrent LLM calls during compile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
    )
    .option("--no-embeddings", "Skip the semantic-search embeddings refresh for this compile")
    .option("--batch-size <n>", "Segmented projects only: sources (or pages) per resumable checkpoint (default 100)")
    .option("--restart", "Segmented projects only: supersede the active batch run and start over from the current inputs")
    .option("--report <runId>", "Print one page of a batch run's per-source and per-page report as JSON (read-only; needs no provider)")
    .option("--cursor <cursor>", "With --report: continue after this cursor")
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)");
}

/**
 * Add the options and action of the `compile` command.
 *
 * @param command - The declared `compile` command.
 * @param deps - The pre-work checks; the CLI uses the real credential guard.
 */
export function registerCompileCommand(command: Command, deps: CompileCommandDeps = DEFAULT_DEPS): void {
  addCompileOptions(command).action(async (options: CompileOptions) => {
    try {
      await runCompile(options, deps);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });
}
