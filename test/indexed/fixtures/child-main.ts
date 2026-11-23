/**
 * @file test/indexed/fixtures/child-main.ts
 * @description The shared entry of the indexed tests' child processes (each a
 * REAL separate process with its own reader lease): run the mode named by the
 * first argument with the remaining arguments and print ONE JSON line, either
 * `{outcome: "ok", result}` or the error's stable code (or its text), its
 * message and any `partial` count. Vitest-free.
 */

/** A child's modes, by name. */
export type ChildModes = Readonly<Record<string, (args: string[]) => Promise<unknown>>>;

/** An error's message. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The JSON line of a failed mode. */
function failureLine(error: unknown): Record<string, unknown> {
  const { code, partial } = error as { code?: unknown; partial?: unknown };
  return { outcome: typeof code === "string" ? code : String(error), message: messageOf(error), ...(partial === undefined ? {} : { partial }) };
}

/** The mode named `mode`, refusing an unknown one. */
function modeOf(modes: ChildModes, mode: string | undefined): (args: string[]) => Promise<unknown> {
  const run = mode === undefined ? undefined : modes[mode];
  if (run === undefined) throw new Error(`unknown mode ${mode}`);
  return run;
}

/** Run the mode `process.argv[2]` of `modes` and print its one JSON line. */
export async function runChildModes(modes: ChildModes): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  try {
    console.log(JSON.stringify({ outcome: "ok", result: await modeOf(modes, mode)(args) }));
  } catch (error) {
    console.log(JSON.stringify(failureLine(error)));
  }
}
