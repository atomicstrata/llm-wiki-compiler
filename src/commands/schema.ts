/**
 * Commander actions for `llmwiki schema` subcommands.
 *
 * Exposes two operations:
 * - `schema init` writes a starter schema file seeded with sensible defaults
 *   so users can customise page kinds and cross-link minimums without
 *   hand-rolling the format.
 * - `schema show` prints the resolved schema a project would use, including
 *   which file (if any) it was loaded from — helpful for debugging.
 *
 * ONE BODY, NO ROOT, for `schema init`. {@link schemaInitCommandWith} owns its
 * decisions (the starter content, refuse-if-exists, then create the directory and
 * write, all under the project gate) over {@link SchemaInitSteps}.
 * {@link schemaInitCommand} keeps its signature, reads the working directory as
 * before, and passes the local steps, which call the incumbent gate, presence
 * look, directory creation and write when asked. `schema show` is one bound read
 * and a print, and stays as it is.
 */

import path from "path";
import * as output from "../utils/output.js";
import { withCooperativeWriterLock } from "../operation-bundles/registered-project-lock.js";
import { makeDirectoryTree } from "../storage/disk-guarded-leaves.js";
import { locationExistsSync, overwriteLocationText } from "../storage/disk-locations.js";
import {
  buildDefaultSchema,
  defaultSchemaInitPath,
  loadSchema,
  serializeSchemaToYaml,
} from "../schema/index.js";

/** The project steps `schema init` takes. No member takes a project root. */
export interface SchemaInitSteps {
  /** Run `write` under the project gate (the gated lock on a registered project). */
  underProjectGate(write: () => Promise<void>): Promise<void>;
  /** Where the starter schema goes, as reported to the operator. */
  targetPath(): string;
  /** Whether anything is at the target already (following links), answered at once. */
  targetExists(): boolean;
  /** Create the target's directory, with any missing parents. */
  ensureTargetDirectory(): Promise<void>;
  /** Write the target's text. */
  writeTarget(text: string): Promise<void>;
}

/** LOCAL DISK. The incumbent gate, presence look, directory creation and write for `root`, each called when asked. */
function localSchemaInitSteps(root: string): SchemaInitSteps {
  const targetPath = (): string => defaultSchemaInitPath(root);
  return {
    underProjectGate: (write) => withCooperativeWriterLock(root, "schema init", write),
    targetPath,
    targetExists: () => locationExistsSync(targetPath()),
    ensureTargetDirectory: () => makeDirectoryTree(path.dirname(targetPath())),
    writeTarget: (text) => overwriteLocationText(targetPath(), text),
  };
}

/**
 * Write a starter schema file to `.llmwiki/schema.json` under the project root.
 * Refuses to overwrite an existing file so `schema init` is safe to re-run.
 */
export async function schemaInitCommand(): Promise<void> {
  return schemaInitCommandWith(localSchemaInitSteps(process.cwd()));
}

/** {@link schemaInitCommand} over {@link SchemaInitSteps}: THE ONE BODY. */
export async function schemaInitCommandWith(steps: SchemaInitSteps): Promise<void> {
  // The schema is a semantic input of every compile, so it is written under the
  // project lock (the gated lock once the project is registered).
  await steps.underProjectGate(() => writeStarterSchema(steps));
}

/** Write the starter schema unless one already exists. */
async function writeStarterSchema(steps: SchemaInitSteps): Promise<void> {
  const defaults = buildDefaultSchema();
  const targetPath = steps.targetPath();

  if (steps.targetExists()) {
    output.status("!", output.warn(`Schema file already exists at ${targetPath}`));
    return;
  }

  await steps.ensureTargetDirectory();
  const serializable = {
    version: defaults.version,
    defaultKind: defaults.defaultKind,
    kinds: defaults.kinds,
    seedPages: defaults.seedPages,
  };
  await steps.writeTarget(`${JSON.stringify(serializable, null, 2)}\n`);
  output.status("+", output.success(`Wrote schema to ${targetPath}`));
}

/**
 * Print the resolved schema for the current project, showing defaults and
 * whichever file (if any) supplied overrides.
 */
export async function schemaShowCommand(): Promise<void> {
  const schema = await loadSchema(process.cwd());
  const loadedFrom = schema.loadedFrom ?? "(defaults — no schema file found)";
  output.header(`Schema (${loadedFrom})`);
  console.log(serializeSchemaToYaml(schema));
}
