/**
 * CLI entry point for llmwiki — the knowledge compiler.
 *
 * Registers all commands (ingest, compile, query, watch, lint) via Commander.
 * Validates the correct API key for the selected LLM provider.
 * Designed for `npx llmwiki` or global install via `npm install -g llm-wiki-compiler`.
 */

import "dotenv/config";
import { createRequire } from "module";
import { Command } from "commander";
import ingestCommand from "./commands/ingest.js";
import ingestSessionCommand from "./commands/ingest-session.js";
import compileCommand from "./commands/compile.js";
import queryCommand from "./commands/query.js";
import watchCommand from "./commands/watch.js";
import lintCommand from "./commands/lint.js";
import exportCommand from "./commands/export.js";
import { schemaInitCommand, schemaShowCommand } from "./commands/schema.js";
import reviewListCommand from "./commands/review-list.js";
import reviewShowCommand from "./commands/review-show.js";
import reviewApproveCommand from "./commands/review-approve.js";
import reviewRejectCommand from "./commands/review-reject.js";
import { startMCPServer } from "./mcp/server.js";
import { DEFAULT_PROVIDER } from "./utils/constants.js";
import { resolveAnthropicAuthFromEnv } from "./utils/claude-settings.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command();

program
  .name("llmwiki")
  .description("The knowledge compiler — raw sources in, interlinked wiki out")
  .version(version);

program
  .command("ingest <source>")
  .description("Ingest a URL or local file into sources/")
  .action(async (source: string) => {
    try {
      await ingestCommand(source);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("ingest-session <path>")
  .description("Ingest a coding-agent session export (Claude, Codex, Cursor) into sources/")
  .action(async (targetPath: string) => {
    try {
      await ingestSessionCommand(targetPath);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("compile")
  .description("Compile sources/ into an interlinked wiki")
  .option(
    "--review",
    "Write generated pages as review candidates under .llmwiki/candidates/ instead of mutating wiki/. Orphan-marking for deleted sources is deferred until the next non-review compile.",
  )
  .option(
    "--lang <code>",
    "Target language for generated wiki content (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .action(async (options: { review?: boolean; lang?: string }) => {
    try {
      applyLanguageOption(options.lang);
      requireProvider();
      await compileCommand({ review: options.review });
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const reviewCommand = program
  .command("review")
  .description("Inspect and act on pending compile review candidates");

reviewCommand
  .command("list")
  .description("List pending review candidates")
  .action(async () => {
    try {
      await reviewListCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

reviewCommand
  .command("show <id>")
  .description("Print a single candidate's metadata and body")
  .action(async (id: string) => {
    try {
      await reviewShowCommand(id);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

reviewCommand
  .command("approve <id>")
  .description("Approve a candidate and promote it into wiki/concepts/")
  .action(async (id: string) => {
    try {
      await reviewApproveCommand(id);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

reviewCommand
  .command("reject <id>")
  .description("Reject a candidate and archive it without touching wiki/")
  .action(async (id: string) => {
    try {
      await reviewRejectCommand(id);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("query <question>")
  .description("Ask a question against the wiki")
  .option("--save", "Save the answer as a wiki page")
  .option("--debug", "Print which pages and chunks were selected and their scores")
  .option(
    "--lang <code>",
    "Target language for the answer (e.g. \"Chinese\", \"ja\", \"zh-CN\"). Equivalent to setting LLMWIKI_OUTPUT_LANG.",
  )
  .action(
    async (
      question: string,
      options: { save?: boolean; debug?: boolean; lang?: string },
    ) => {
      try {
        applyLanguageOption(options.lang);
        requireProvider();
        await queryCommand(process.cwd(), question, options);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    },
  );

program
  .command("watch")
  .description("Watch sources/ and auto-recompile on changes")
  .action(async () => {
    try {
      requireProvider();
      await watchCommand();
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

const schemaCmd = program
  .command("schema")
  .description("Inspect or initialize the project's wiki schema config");

schemaCmd
  .command("init")
  .description("Write a starter schema file to .llmwiki/schema.json")
  .action(async () => {
    try {
      await schemaInitCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

schemaCmd
  .command("show")
  .description("Print the resolved schema for this project")
  .action(async () => {
    try {
      await schemaShowCommand();
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

program
  .command("export")
  .description("Export wiki content to portable formats (llms.txt, JSON, GraphML, Marp, …)")
  .option("--target <name>", "Limit export to a single target format")
  .option(
    "--source <kind>",
    "For marp target: which pages to include — concepts, queries, or all (default: all)",
  )
  .action(async (options: { target?: string; source?: string }) => {
    try {
      await exportCommand(process.cwd(), options);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
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
 * Apply the --lang CLI option by setting LLMWIKI_OUTPUT_LANG so prompt
 * builders pick it up (issue #37). Single env slot keeps the resolution
 * order simple: explicit flag wins over the inherited environment.
 */
function applyLanguageOption(lang: string | undefined): void {
  if (lang && lang.trim().length > 0) {
    process.env.LLMWIKI_OUTPUT_LANG = lang.trim();
  }
}

/** API key env var required per provider. Null means no key needed. */
const PROVIDER_KEY_VARS: Record<string, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: null,
  minimax: "MINIMAX_API_KEY",
  copilot: "GITHUB_TOKEN",
};

/** Exit with a helpful message if the selected provider's API key is missing. */
function requireProvider(): void {
  const provider = process.env.LLMWIKI_PROVIDER ?? DEFAULT_PROVIDER;

  if (provider === "anthropic") {
    const auth = resolveAnthropicAuthFromEnv();
    if (!auth.apiKey && !auth.authToken) {
      console.error(
        `\x1b[31mError:\x1b[0m Anthropic credentials are required for the "anthropic" provider.\n` +
          `  Set one of: export ANTHROPIC_API_KEY=<your-key> OR export ANTHROPIC_AUTH_TOKEN=<your-token>`,
      );
      process.exit(1);
    }
    return;
  }

  const keyVar = PROVIDER_KEY_VARS[provider];

  if (keyVar === undefined) {
    console.error(
      `\x1b[31mError:\x1b[0m Unknown provider "${provider}".\n` +
        `  Supported: ${Object.keys(PROVIDER_KEY_VARS).join(", ")}`,
    );
    process.exit(1);
  }

  if (keyVar && !process.env[keyVar]) {
    console.error(
      `\x1b[31mError:\x1b[0m ${keyVar} environment variable is required for the "${provider}" provider.\n` +
        `  Set it with: export ${keyVar}=<your-key>`,
    );
    process.exit(1);
  }
}

program.parse();
