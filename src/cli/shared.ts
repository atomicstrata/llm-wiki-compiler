/**
 * @file src/cli/shared.ts
 * @description Small helpers shared across `src/cli.ts` and the per-domain
 * `src/cli/<domain>-commands.ts` modules. Centralized here (rather than left
 * in `cli.ts`) because both the staying commands (`next`, `context`,
 * `quickstart`) and moved groups (`profile`, `workflow`) use them.
 */

import * as output from "../utils/output.js";

/**
 * The stable id every local CLI command records as the acting operator. It lives
 * here, in the neutral CLI-shared module, because the preparation, operation, and
 * product command groups all stamp the same "local operator" onto the runs and
 * bindings they author — two spellings would put two different ids in one shell
 * session's audit trail, and one group importing another's copy would drag that
 * group's whole import reach along with the constant.
 */
export const CLI_OPERATOR_ID = "cli-operator";

/**
 * Run one command's work with human output SUPPRESSED for `--json`.
 *
 * THE SKELETON THIS REPLACES HAD FOUR COPIES and had already been got wrong
 * once per copy: without the suppression a helper's advisory line ("Another
 * compilation is running.") lands on stdout ahead of the envelope and
 * `JSON.parse` fails on every invocation; without the `finally` an operation
 * that throws leaves the whole process quiet. Both halves now travel together,
 * which is the same argument the exit-code wrapper below is centralised on.
 *
 * @param json - Whether the caller asked for the machine-readable envelope.
 * @param work - The command's work, run inside the quiet scope.
 * @returns Whatever `work` resolves to.
 */
export async function withQuietJson<T>(json: boolean, work: () => Promise<T>): Promise<T> {
  if (!json) return work();
  output.setQuiet(true);
  try {
    return await work();
  } finally {
    output.setQuiet(false);
  }
}

/**
 * Wrap a command implementation that returns an exit code with the
 * shared CLI exit semantics: assign process.exitCode for non-zero
 * returns (so stdout can drain before the event loop exits) and
 * print a red-formatted error then process.exit(1) on throws.
 *
 * Centralised so command actions stay one-liners and fallow does not
 * flag the try/catch+exitCode skeleton as duplicated across siblings.
 */
export async function runExitCodeCommand(
  work: () => Promise<number>,
  options: { colorError?: boolean } = {},
): Promise<void> {
  try {
    const code = await work();
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(formatExitError(err, options.colorError));
    process.exit(1);
  }
}

function formatExitError(error: unknown, colorError: boolean | undefined): string {
  const label = colorError === false ? "Error:" : "\x1b[31mError:\x1b[0m";
  const message = error instanceof Error ? error.message : error;
  return `${label} ${message}`;
}
