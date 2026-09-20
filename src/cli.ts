/**
 * CLI entry point for llmwiki — the knowledge compiler.
 *
 * Registers all commands (ingest, compile, query, watch, lint) via Commander.
 * Validates the correct API key for the selected LLM provider.
 * Designed for `npx llmwiki` or global install via `npm install -g llm-wiki-compiler`.
 */

import { createRequire } from "module";
import { Command } from "commander";
import { ingestCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { ingestSessionCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { viewCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { visualizeCommand, type VisualizeOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { compileCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { rmCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { queryCommand, assertQuerySaveOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { watchCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { lintCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { statusCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { exportCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { importCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { recoverCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { registerRulesCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { registerContextCommands } from "./cli/context-commands.js";
import { refreshCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { quickstartCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { startMCPServer } from "./mcp/server.js";
import { applyLanguageOption } from "@atomicstrata/llmwiki-core/compiler-cli";
import { applySourcesSectionOption } from "@atomicstrata/llmwiki-core/compiler-cli";
import { readInstructions } from "./cli/instructions.js";
import { ensureCompileProviderAvailable, ensureProviderAvailable } from "@atomicstrata/llmwiki-core/compiler-cli";
import { setVerbose } from "@atomicstrata/llmwiki-core/compiler-cli";
import { parseConcurrencyFlag } from "@atomicstrata/llmwiki-core/compiler-cli";
import { ENV_VERBOSE } from "@atomicstrata/llmwiki-core/compiler-cli";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { registerStateCommands } from "./cli/state-commands.js";
import { registerSchemaCommands } from "./cli/schema-commands.js";
import { registerProfileCommands } from "./cli/profile-commands.js";
import { registerTemplateCommands } from "./cli/template-commands.js";
import { registerArtifactCommands } from "./cli/artifact-commands.js";
import { registerReviewCommands } from "./cli/review-commands.js";
import { registerEvalCommands } from "./cli/eval-commands.js";
import { registerWorkflowCommands } from "./cli/workflow-commands.js";
import { registerConnectorCommands } from "./cli/connector-commands.js";
import { registerOperationCommands } from "./cli/operation-commands.js";
import { registerProductCommands } from "./cli/product-commands.js";
import { registerPreparationCommands } from "./cli/preparation-commands.js";
import { addProviderOption, applyProviderOption, type ProviderOption } from "@atomicstrata/llmwiki-core/compiler-cli";
import { loadCliEnvironment } from "./cli/environment.js";

loadCliEnvironment();

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Returns true when the --verbose flag was passed or LLMWIKI_VERBOSE is set
 * to a non-empty value in the environment. Both paths call setVerbose(true)
 * at the start of the action so verbose() emits output for that run only.
 */
function verboseEnabled(flag?: boolean): boolean {
  return Boolean(flag) || Boolean(process.env[ENV_VERBOSE]?.trim());
}

const program = new Command();

program
  .name("llmwiki")
  .description("The knowledge compiler — raw sources in, interlinked wiki out")
  .version(version);

program
  .command("ingest <source>")
  .description("Ingest a URL or local file into sources/")
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (source: string, options: { verbose?: boolean }) => {
    try {
      setVerbose(verboseEnabled(options.verbose));
      await ingestCommand(source);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("ingest-session <path>")
  .description("Ingest a coding-agent session export (Claude, Codex, Cursor) into sources/")
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (targetPath: string, options: { verbose?: boolean }) => {
    try {
      setVerbose(verboseEnabled(options.verbose));
      await ingestSessionCommand(targetPath);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("view")
  .description("Start a local read-only web viewer for the current wiki project")
  .option("--port <port>", "Port to bind (default 0 — OS-assigned)")
  .option("--host <host>", "Host to bind (requires --allow-lan; default 127.0.0.1)")
  .option("--allow-lan", "Bind beyond loopback (requires --host); off by default for privacy")
  .option("--open", "Open the viewer in the default browser after startup")
  .action(async (options: { port?: string; host?: string; allowLan?: boolean; open?: boolean }) => {
    try {
      await viewCommand(options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

addProviderOption(program.command("compile").description("Compile sources/ into an interlinked wiki"))
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
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (options: ProviderOption & {
    review?: boolean;
    lang?: string;
    sourcesSection?: boolean;
    instructions?: string;
    concurrency?: string;
    verbose?: boolean;
  }) => {
    try {
      applyProviderOption(options);
      setVerbose(verboseEnabled(options.verbose));
      applyLanguageOption(options.lang);
      applySourcesSectionOption(options.sourcesSection);
      const systemPolicy = await readInstructions(options.instructions);
      requireCompileProvider();
      await compileCommand({ review: options.review, concurrency: parseConcurrencyFlag(options.concurrency), systemPolicy });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("rm <source>")
  .description("Delete a source and the concept pages derived exclusively from it")
  .option("--dry-run", "Print what would be deleted and kept without changing anything")
  .action(async (source: string, options: { dryRun?: boolean }) => {
    try {
      const code = await rmCommand(source, { dryRun: options.dryRun });
      process.exit(code);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

addProviderOption(program.command("refresh").description("Recompile only stale/changed pages without touching unrelated new sources"))
  .option("--stale", "Resolve stale/orphaned pages and recompile them")
  .option("--dry-run", "Print the refresh plan without calling the LLM or writing files")
  .option(
    "--concurrency <n>",
    "Max concurrent LLM calls during the recompile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
  )
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (options: ProviderOption & { stale?: boolean; dryRun?: boolean; concurrency?: string; verbose?: boolean }) => {
    try {
      applyProviderOption(options);
      setVerbose(verboseEnabled(options.verbose));
      const code = await refreshCommand(
        { stale: options.stale, dryRun: options.dryRun, concurrency: parseConcurrencyFlag(options.concurrency) },
        requireCompileProvider,
      );
      process.exit(code);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

registerReviewCommands(program);

registerStateCommands(program);

program
  .command("recover")
  .description("Recover an incomplete compile (revert a crashed compile's journal) without a full recompile.")
  .action(async () => {
    try {
      await recoverCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

registerRulesCommand(program, requireProvider);

addProviderOption(program.command("query <question>").description("Ask a question against the wiki"))
  .option("--save", "Save the answer as a wiki page")
  .option("--review", "Stage the answer for review instead of publishing (requires --save)")
  .option("--debug", "Print which pages and chunks were selected and their scores")
  .option(
    "--lang <code>",
    "Target language for the answer (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(
    async (
      question: string,
      options: ProviderOption & { save?: boolean; review?: boolean; debug?: boolean; lang?: string; verbose?: boolean },
    ) => {
      try {
        assertQuerySaveOptions(options);
        applyProviderOption(options);
        setVerbose(verboseEnabled(options.verbose));
        applyLanguageOption(options.lang);
        requireProvider();
        await queryCommand(process.cwd(), question, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    },
  );

addProviderOption(program.command("watch").description("Watch sources/ and auto-recompile on changes"))
  .option(
    "--concurrency <n>",
    "Max concurrent LLM calls per recompile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
  )
  .action(async (options: ProviderOption & { concurrency?: string }) => {
    try {
      applyProviderOption(options);
      requireCompileProvider();
      await watchCommand({ concurrency: parseConcurrencyFlag(options.concurrency) });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("visualize")
  .description("Create Obsidian graph configuration and Canvas knowledge maps without overwriting edits")
  .option("--focus <nodeId>", "Centre the canvas on one node, e.g. papers/alpha")
  .option("--depth <hops>", "Hops around --focus (default 1)")
  .action(async (options: VisualizeOptions) => {
    try {
      process.exitCode = await visualizeCommand(process.cwd(), options);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command("lint")
  .description("Run rule-based quality checks against the wiki")
  .option("--tiered", "Separate broken content, model judgements, and stale derived views")
  .option("--fix-preview", "Preview deterministic repairs without applying them")
  .option("--fix-propose <n>", "Propose the nth previewed repair for review; applies nothing")
  .action(async (options: { tiered?: boolean; fixPreview?: boolean; fixPropose?: string }) => {
    try {
      await lintCommand({
        tiered: options.tiered,
        fixPreview: options.fixPreview,
        ...(options.fixPropose === undefined ? {} : { fixPropose: Number(options.fixPropose) }),
      });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Report project status: page/source counts, stale and orphaned pages, pending changes, review queue, and state health")
  .option("--json", "Emit the status snapshot as JSON (same shape as the MCP wiki_status tool)")
  .action(async (options: { json?: boolean }) => {
    try {
      const code = await statusCommand({ json: options.json });
      process.exit(code);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

registerEvalCommands(program);

registerSchemaCommands(program);

registerProfileCommands(program);

registerTemplateCommands(program);

registerWorkflowCommands(program);

registerArtifactCommands(program);

registerConnectorCommands(program);
registerOperationCommands(program);
registerProductCommands(program);
registerPreparationCommands(program);

program
  .command("export")
  .description("Export wiki content to portable formats (llms.txt, JSON, GraphML, Marp, …)")
  .option("--target <name>", "Limit export to a single target format")
  .option(
    "--source <kind>",
    "For marp target: which pages to include — concepts, queries, or all (default: all)",
  )
  .option(
    "--project-id <id>",
    "Bridge identifier embedded in the JSON export envelope. Must match /^[a-z0-9][a-z0-9-]{0,62}$/.",
  )
  .option("--out <dir>", "Output directory for directory-style targets (e.g. okf)")
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (options: { target?: string; source?: string; projectId?: string; out?: string; verbose?: boolean }) => {
    try {
      setVerbose(verboseEnabled(options.verbose));
      await exportCommand(process.cwd(), options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("import")
  .description("Import an OKF bundle as review candidates (default) or live pages (--trusted)")
  .requiredOption("--okf <dir>", "Path to the OKF bundle directory to import")
  .option(
    "--trusted",
    "Write mapped pages directly into wiki/ instead of staging for review (you vouch for the bundle's contents and its self-declared provenance)",
  )
  .option("--dry-run", "Report what would be imported (and skipped) without writing anything")
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (options: { okf: string; trusted?: boolean; dryRun?: boolean; verbose?: boolean }) => {
    try {
      setVerbose(verboseEnabled(options.verbose));
      await importCommand(process.cwd(), options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

registerContextCommands(program, verboseEnabled);

program
  .command("quickstart <source>")
  .description(
    "Ingest a source and compile it into a wiki in one step. Recommends the next action when finished.",
  )
  .option("--review", "Generate review candidates instead of mutating wiki/")
  .option("--no-open", "Skip the viewer handoff after a successful compile")
  .option(
    "--provider <name>",
    "Override LLMWIKI_PROVIDER for this run only (e.g. anthropic, codex-agent, openai, ollama)",
  )
  .option(
    "--lang <code>",
    "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .option("--json", "Emit the quickstart JSON envelope instead of human output (implies --no-open)")
  .option(
    "--concurrency <n>",
    "Max concurrent LLM calls during the compile step (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
  )
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (
    source: string,
    options: {
      review?: boolean; open?: boolean; provider?: string;
      lang?: string; json?: boolean; concurrency?: string; verbose?: boolean;
    },
  ) => {
    setVerbose(verboseEnabled(options.verbose));
    return runExitCodeCommand(() => quickstartCommand(source, {
      review: options.review,
      open: options.open,
      provider: options.provider,
      lang: options.lang,
      json: options.json,
      // Choose the warning channel here: argument expressions evaluate before the callee body runs.
      // Quickstart's own JSON quiet mode therefore can never intercept this warning.
      concurrency: parseConcurrencyFlag(options.concurrency, options.json ? "stderr" : "stdout"),
    }));
  });

program
  .command("serve")
  .description("Start an MCP server exposing wiki tools and resources over stdio")
  .option("--root <dir>", "Project root directory", process.cwd())
  .action(async (options: { root: string }) => {
    try {
      // Per-tool credential checks happen inside the MCP layer so read-only
      // tools and ingest still work without an API key.
      await startMCPServer({ root: options.root, version });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

/**
 * Run the shared provider guard but match the legacy CLI error path:
 * print the error in red and exit 1 instead of letting the throw
 * surface as a stack trace. Programmatic callers use the underlying guards
 * directly so they can convert the throw into a structured envelope.
 */
function requireProvider(): void {
  requireAvailableProvider(ensureProviderAvailable);
}

/** Run the compile-aware provider guard through the legacy CLI error path. */
function requireCompileProvider(): void {
  requireAvailableProvider(ensureCompileProviderAvailable);
}

/** Print a provider-guard failure in red and exit through the legacy path. */
function requireAvailableProvider(ensureAvailable: () => void): void {
  try {
    ensureAvailable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mError:\x1b[0m ${message}`);
    process.exit(1);
  }
}

program.parse();
