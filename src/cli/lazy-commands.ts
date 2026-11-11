/**
 * @file src/cli/lazy-commands.ts
 * @description Declare a command group from a table and load each command's
 * module only when that command runs.
 *
 * `src/cli.ts` and every command group with subcommands list their commands
 * here as `[usage, description, load]`. Each command is declared with its name,
 * arguments and description only, so help for the group needs no command
 * module. Commander's `preSubcommand` hook loads the module just before the
 * command parses its arguments, and that module adds the command's options,
 * action and subcommands with ordinary static imports. A command that runs
 * therefore loads its own implementation and nothing behind its siblings.
 */

import type { Command } from "commander";

/** Add a command's options, action and subcommands. */
export type Configure = (command: Command) => void;

/** One command: its usage as help prints it, its description, and the loader of its configuration. */
export type LazyCommand = [usage: string, description: string, load: () => Promise<Configure>];

/**
 * Commander lists `[options]` only for a command that has options, and a
 * declared command has none until its module loads, so the usage from the
 * table is what the group's command list prints.
 */
const OPTIONS_MARKER = " [options]";

/**
 * Declare every command of `table` on `group`, in order, and load each
 * command's module when it runs or when `help <command>` prints its help.
 *
 * @param group - The program or command group the commands belong to.
 * @param table - The group's commands in help order.
 */
export function declareLazyCommands(group: Command, table: readonly LazyCommand[]): void {
  const listed = new Map<Command, LazyCommand>();
  for (const entry of table) {
    const [usage, description] = entry;
    listed.set(group.command(usage.replace(OPTIONS_MARKER, "")).description(description), entry);
  }

  const help = group.createHelp();
  group.configureHelp({ subcommandTerm: (command) => listed.get(command)?.[0] ?? help.subcommandTerm(command) });

  /** Add a listed command's options, action and subcommands from its module. */
  async function configure(command: Command): Promise<void> {
    const entry = listed.get(command);
    if (entry) (await entry[2]())(command);
  }

  group.hook("preSubcommand", (_group, command) => configure(command));
  declareHelpCommand(group, configure);
}

/**
 * Replace Commander's own `help <command>`, which prints the declared command
 * without running the hook, with one that configures the command first. Its
 * name, description and place at the end of the command list match the one
 * it replaces.
 */
function declareHelpCommand(group: Command, configure: (command: Command) => Promise<void>): void {
  group.helpCommand(false);
  group
    .command("help [command]")
    .description("display help for command")
    .helpOption(false)
    .allowExcessArguments()
    .action(async (name?: string) => {
      const command = name === undefined ? group : group.commands.find((candidate) => candidate.name() === name);
      if (command === undefined) return group.help({ error: true });
      await configure(command);
      command.help();
    });
}
