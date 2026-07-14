/**
 * @file src/cli/shared.ts
 * @description Small helpers shared across `src/cli.ts` and the per-domain
 * `src/cli/<domain>-commands.ts` modules. Centralized here (rather than left
 * in `cli.ts`) because both the staying commands (`next`, `context`,
 * `quickstart`) and moved groups (`profile`, `workflow`) use them.
 */

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
