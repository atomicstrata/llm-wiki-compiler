/**
 * CLI entry point for llmwiki — the knowledge compiler.
 *
 * Registers all commands (ingest, compile, query, watch, lint) via Commander.
 * Validates the correct API key for the selected LLM provider.
 * Designed for `npx llmwiki` or global install via `npm install -g llm-wiki-compiler`.
 */

import { createRequire } from "module";
import { Command } from "commander";
import ingestCommand from "./commands/ingest.js";
import ingestSessionCommand from "./commands/ingest-session.js";
import viewCommand from "./commands/view.js";
import compileCommand from "./commands/compile.js";
import { rmCommand } from "./commands/rm.js";
import queryCommand from "./commands/query.js";
import watchCommand from "./commands/watch.js";
import lintCommand from "./commands/lint.js";
import statusCommand from "./commands/status.js";
import exportCommand from "./commands/export.js";
import importCommand from "./commands/import.js";
import { recoverCommand } from "./commands/recover.js";
import { registerRulesCommand } from "./commands/rules-register.js";
import nextCommand from "./commands/next.js";
import refreshCommand from "./commands/refresh.js";
import quickstartCommand from "./commands/quickstart.js";
import contextCommand, { type ContextCommandOptions } from "./commands/context.js";
import { startMCPServer } from "./mcp/server.js";
import { applyLanguageOption } from "./utils/output-language.js";
import { ensureProviderAvailable } from "./utils/provider-guard.js";
import { setVerbose } from "./utils/output.js";
import { parseConcurrencyFlag } from "./compiler/concurrency.js";
import { ENV_VERBOSE } from "./utils/constants.js";
import { runExitCodeCommand } from "./cli/shared.js";
import { registerStateCommands } from "./cli/state-commands.js";
import { registerSchemaCommands } from "./cli/schema-commands.js";
import { registerProfileCommands } from "./cli/profile-commands.js";
import { registerTemplateCommands } from "./cli/template-commands.js";
import { registerArtifactCommands } from "./cli/artifact-commands.js";
import { registerReviewCommands } from "./cli/review-commands.js";
import { registerEvalCommands } from "./cli/eval-commands.js";
import { registerWorkflowCommands } from "./cli/workflow-commands.js";
import { registerConnectorCommands } from "./cli/connector-commands.js";
import {
  addProviderOption,
  applyProviderOption,
  type ProviderOption,
} from "./cli/provider-option.js";
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
  .option(
    "--review",
    "Write generated pages as review candidates under .llmwiki/candidates/ instead of mutating wiki/. Orphan-marking for deleted sources is deferred until the next non-review compile.",
  )
  .option(
    "--lang <code>",
    "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .option(
    "--concurrency <n>",
    "Max concurrent LLM calls during compile (or set LLMWIKI_COMPILE_CONCURRENCY; default 5)",
  )
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (options: ProviderOption & { review?: boolean; lang?: string; concurrency?: string; verbose?: boolean }) => {
    try {
      applyProviderOption(options);
      setVerbose(verboseEnabled(options.verbose));
      applyLanguageOption(options.lang);
      requireProvider();
      await compileCommand({ review: options.review, concurrency: parseConcurrencyFlag(options.concurrency) });
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
        requireProvider,
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
  .option("--debug", "Print which pages and chunks were selected and their scores")
  .option(
    "--lang <code>",
    "Target language for the answer (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(
    async (
      question: string,
      options: ProviderOption & { save?: boolean; debug?: boolean; lang?: string; verbose?: boolean },
    ) => {
      try {
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
      requireProvider();
      await watchCommand({ concurrency: parseConcurrencyFlag(options.concurrency) });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("lint")
  .description("Run rule-based quality checks against the wiki")
  .action(async () => {
    try {
      await lintCommand();
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

program
  .command("next")
  .description("Show the recommended next action for this llmwiki project (read-only)")
  .option("--json", "Emit a stable JSON envelope for agent consumption")
  .action(async (options: { json?: boolean }) =>
    runExitCodeCommand(() => nextCommand({ json: options.json })),
  );

program
  .command("context <prompt>")
  .description(
    "Build an agent-ready evidence pack for <prompt> from the compiled wiki " +
      "(read-only; provider credentials optional — semantic retrieval is used " +
      "when available and falls back to lexical otherwise)",
  )
  .option("--budget <tokens>", "Approximate output token budget (default 8000)")
  .option("--format <format>", "Output format: json | markdown (default markdown)")
  .option("--json", "Emit the stable v1 JSON envelope (overrides --format)")
  .option("--depth <n>", "Graph neighborhood depth, default 1, max 2; 0 disables expansion")
  .option("--top-pages <n>", "Max primary pages (default 5, max 20)")
  .option("--top-chunks <n>", "Max semantic chunks (default 8, max 50)")
  .option("--omit-root", "Emit project.root as null for privacy")
  .option("--no-neighbors", "Suppress graph expansion (keeps neighbors/gaps as empty arrays)")
  .option(
    "--include-sources",
    "Populate primary[].sourceWindows from claim-level citation spans (max 20 windows, 30 lines each)",
  )
  .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
  .action(async (prompt: string, options: ContextCommandOptions & { verbose?: boolean }) => {
    setVerbose(verboseEnabled(options.verbose));
    return runExitCodeCommand(() => contextCommand(prompt, options));
  });

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
 * surface as a stack trace. Programmatic callers (quickstart, MCP) use
 * `ensureProviderAvailable` directly so they can convert the throw into
 * a structured envelope.
 */
function requireProvider(): void {
  try {
    ensureProviderAvailable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31mError:\x1b[0m ${message}`);
    process.exit(1);
  }
}

program.parse();
