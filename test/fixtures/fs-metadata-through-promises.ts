/**
 * @file test/fixtures/fs-metadata-through-promises.ts
 * @description A `utils/fs-metadata.ts` stand-in for tests that inject faults
 * by mocking `fs/promises`.
 *
 * The path-safety primitives look up path metadata through
 * `utils/fs-metadata.ts`, synchronously, so a fault injected on the mocked
 * `fs/promises` would never reach them. Mock that module with this to route
 * each lookup through whatever `fs/promises` currently is:
 *
 *   vi.mock("../src/utils/fs-metadata.js", fsMetadataThroughPromises);
 */

type Forwarded = (...args: unknown[]) => unknown;

/** Forward `name` to the current `fs/promises` export of that name. */
function forwardTo(name: "lstat" | "stat" | "realpath"): Forwarded {
  return async (...args) => ((await import("fs/promises"))[name] as Forwarded)(...args);
}

/** The module factory: `lstat`, `stat` and `realpath`, each asked of `fs/promises` at call time. */
export function fsMetadataThroughPromises(): Record<string, Forwarded> {
  return { lstat: forwardTo("lstat"), stat: forwardTo("stat"), realpath: forwardTo("realpath") };
}
