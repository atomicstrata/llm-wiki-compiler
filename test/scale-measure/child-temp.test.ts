/**
 * @file test/scale-measure/child-temp.test.ts
 * @description The measurement child inherits explicit temp roots and keeps
 * unset temp roots inside the caller's measurement workdir.
 */

import { expect, it } from "bun:test";
import path from "node:path";
import { measuredChildEnvironment } from "./run.js";

/** Explicit temp roots from the driver must reach the child unchanged. */
it("forwards parent temp variables to an offline measurement child", () => {
  const env = measuredChildEnvironment("/measure/work/indexed-2", {}, {
    PATH: "/bin", TMPDIR: "/external/scratch", TMP: "/external/tmp", TEMP: "/external/temp",
  });
  expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([
    "/external/scratch", "/external/tmp", "/external/temp",
  ]);
  expect(env.OPENAI_API_KEY).toBeUndefined();
});

/** Absent temp roots must resolve to the same bounded workdir child directory. */
it("uses measurement workdir for unset child temp variables", () => {
  const env = measuredChildEnvironment("/measure/work/indexed-2", {}, { PATH: "/bin" });
  const expected = path.join("/measure/work", "tmp");
  expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([expected, expected, expected]);
});

/** Empty parent temp values must not send a child to an implicit system temp root. */
it("uses measurement workdir for empty parent temp variables", () => {
  const env = measuredChildEnvironment("/measure/work/indexed-2", {}, {
    PATH: "/bin", TMPDIR: "", TMP: "", TEMP: "",
  });
  const expected = path.join("/measure/work", "tmp");
  expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([expected, expected, expected]);
});
