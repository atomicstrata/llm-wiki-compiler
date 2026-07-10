/**
 * @file test/state-shape-validation.test.ts
 * @description Fail-closed regression tests for parseable-but-malformed
 * `.llmwiki/state.json`. Before this guard, a state object that PARSED as JSON
 * but had a structurally invalid shape (e.g. `sources: null`) classified as
 * `ok`, then crashed read surfaces such as `collectStatus` with
 * "Cannot convert undefined or null to object".
 *
 * `classifyParsedState` now shape-validates a known-version state and routes
 * any malformed-but-parseable file into the existing `corrupt` recovery path,
 * while leaving a genuinely too-new (future-version) file as `too-new` —
 * without deep-validating a format this build does not understand.
 */

import { describe, it, expect } from "vitest";
import { readStateClassified } from "../src/utils/state.js";
import { collectStatus } from "../src/status/collect.js";
import { useLintTempRoot } from "./fixtures/lint-temp-root.js";
import { writeRawTestStateJson, writeTestStateJson } from "./fixtures/state-json.js";

const MALFORMED_NULL_SOURCES = '{"version":2,"indexHash":"","sources":null}';

describe("classifyParsedState — shape validation", () => {
  const env = useLintTempRoot("state-shape-validation");

  it("(a) classifies {version:2,sources:null} as corrupt and does not crash collectStatus", async () => {
    await writeRawTestStateJson(env.dir, MALFORMED_NULL_SOURCES);
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("corrupt");
    expect(result.state.sources).toEqual({});

    const status = await collectStatus(env.dir);
    expect(status.stateStatus).toBe("corrupt");
  });

  it('(b) classifies {version:"10"} and {version:1.5} as corrupt, not too-new', async () => {
    await writeRawTestStateJson(env.dir, '{"version":"10","indexHash":"","sources":{}}');
    expect((await readStateClassified(env.dir)).status).toBe("corrupt");

    await writeRawTestStateJson(env.dir, '{"version":1.5,"indexHash":"","sources":{}}');
    expect((await readStateClassified(env.dir)).status).toBe("corrupt");
  });

  it("(b2) classifies version:0 as corrupt", async () => {
    await writeRawTestStateJson(env.dir, '{"version":0,"indexHash":"","sources":{}}');
    expect((await readStateClassified(env.dir)).status).toBe("corrupt");
  });

  it("(c) classifies a valid v1 state as ok", async () => {
    await writeTestStateJson(env.dir, {
      version: 1,
      indexHash: "h",
      sources: { "a.md": { hash: "h", concepts: ["x"], compiledAt: "t" } },
    });
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("ok");
    expect(result.state.sources["a.md"].hash).toBe("h");
  });

  it("(c) classifies a valid v2 state (with entities) as ok", async () => {
    await writeTestStateJson(env.dir, {
      version: 2,
      indexHash: "h",
      sources: {
        "a.md": { hash: "h", concepts: ["x"], compiledAt: "t", entities: ["concepts/x"] },
      },
      frozenSlugs: ["y"],
      frozenEntities: ["concepts/y"],
    });
    expect((await readStateClassified(env.dir)).status).toBe("ok");
  });

  it("(d) classifies a too-new {version:3, valid shape} as too-new", async () => {
    await writeRawTestStateJson(env.dir, '{"version":3,"indexHash":"h3","sources":{}}');
    const result = await readStateClassified(env.dir);
    expect(result.status).toBe("too-new");
    expect(result.state.version).toBe(3);
  });

  it("(d2) classifies a too-new {version:3} even with a bad shape as too-new (not deep-validated)", async () => {
    await writeRawTestStateJson(env.dir, '{"version":3,"indexHash":"","sources":null}');
    expect((await readStateClassified(env.dir)).status).toBe("too-new");
  });
});
