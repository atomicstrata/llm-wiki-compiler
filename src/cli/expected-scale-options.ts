/**
 * @file src/cli/expected-scale-options.ts
 * @description The expected-scale flags that `quickstart` accepts before it
 * ingests anything. They live in their own module so that loading `quickstart`
 * does not load the `init`, `scale` and `catalog` registrations, which the lazy
 * CLI loads only when those commands run. An expected scale is a planning
 * target, not verified capacity.
 */

import type { Command } from "commander";

/** The parsed expected-scale flags. */
export interface ExpectedScaleFlags {
  expectedSize?: string;
  expectedDocuments?: string;
}

/**
 * Add quickstart's expected-scale flags to `command` (they are set before anything is ingested).
 *
 * @param command - The command to add the flags to.
 * @returns The same command, for chaining.
 */
export function addExpectedScaleOptions(command: Command): Command {
  return command
    .option("--expected-size <size>", "Set the expected total source size (e.g. 5MB) before ingesting; a planning target, not verified capacity")
    .option("--expected-documents <n>", "Set the expected document count before ingesting; either estimate alone is enough");
}
