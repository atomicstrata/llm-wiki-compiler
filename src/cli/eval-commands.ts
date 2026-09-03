/**
 * @file src/cli/eval-commands.ts
 * @description Registers the `eval` command group: evaluate wiki quality
 * (health, citation coverage, LLM judge) and inspect eval history/cache
 * (`eval`, `eval cache clear|show`, `eval report`, `eval history`,
 * `eval judgements`). Moved out of `src/cli.ts` verbatim (pure move, no
 * behavior change) as part of the per-domain command split.
 */

import type { Command } from "commander";
import evalCommand, {
  evalCacheClearCommand,
  evalCacheShowCommand,
  evalReportCommand,
  evalHistoryCommand,
  evalJudgementsCommand,
} from "../commands/eval.js";
import { addProviderOption, applyProviderOption, type ProviderOption } from "./provider-option.js";

/** Register the `eval cache` sub-group (`clear`, `show`) under the parent `eval` command. */
function registerEvalCacheCommands(evalCmd: Command): void {
  const evalCacheCmd = evalCmd.command("cache").description("Manage the citation judgement cache");

  evalCacheCmd
    .command("clear")
    .description("Delete the cache so all judgements re-run on the next full eval")
    .action(async () => {
      try { await evalCacheClearCommand(); }
      catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
    });

  evalCacheCmd
    .command("show")
    .description("Print a score distribution summary of cached citation judgements")
    .action(async () => {
      try { await evalCacheShowCommand(); }
      catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
    });
}

/** Register the `eval` command group (root eval + `cache`/`report`/`history`/`judgements`) on `program`. */
export function registerEvalCommands(program: Command): void {
  const evalCmd = addProviderOption(
    program.command("eval").description("Evaluate wiki quality (health, citation coverage, LLM judge)"),
  )
    .option("--suite <level>", "fast (deterministic) or full (+ LLM judge)", "fast")
    .option("--out <format>", "terminal or json", "terminal")
    .option("--sample <n>", "number of citations to judge in full suite", "20")
    .action(async (opts: ProviderOption & { suite: string; out: string; sample: string }) => {
      try {
        applyProviderOption(opts);
        await evalCommand(opts);
      } catch (err) {
        console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });

  registerEvalCacheCommands(evalCmd);

  evalCmd
    .command("report")
    .description("Re-display the most recent eval report without running a new eval")
    .option("--out <format>", "terminal or json", "terminal")
    .action(async (opts) => {
      try { await evalReportCommand(opts); }
      catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
    });

  evalCmd
    .command("history")
    .description("Show a trend table of past eval runs")
    .option("--n <count>", "number of runs to show", "10")
    .option("--out <format>", "terminal or json", "terminal")
    .action(async (opts) => {
      try { await evalHistoryCommand(opts); }
      catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
    });

  evalCmd
    .command("judgements")
    .description("Browse cached citation judgements")
    .option("--score <0|1|2>", "filter by support score (0=unsupported, 1=partial, 2=full)")
    .option("--page <slug>", "filter by wiki page slug")
    .option("--n <count>", "limit number of judgements shown")
    .option("--out <format>", "terminal or json", "terminal")
    .action(async (opts) => {
      try { await evalJudgementsCommand(opts); }
      catch (err) { console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`); process.exit(1); }
    });
}
