/**
 * @file test/operations-packs/plan-compiler-determinism.test.ts
 * @description The plan compiler is a PURE function of its request (design
 * section 17.3): byte-identical requests compile to byte-identical plan documents
 * and digests. The permutations here change everything that is NOT part of the
 * request's meaning — the key order of the caller input, of every object map in
 * the pack and the binding, and the process time zone and locale — and the
 * compiled bytes must not move. The negative half keeps the test honest: a change
 * that DOES alter meaning (an input value, the invoked action, a recipe body, an
 * authority digest) must move the digest, or the assertions above would pass over
 * a compiler that ignored its request.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compilePackAction } from "../../src/operations-packs/compiler.js";
import type { CompilePackActionRequestV1 } from "../../src/operations-packs/compiler-types.js";
import { buildCompileRequest, RECIPE_ID } from "./compile-fixture.js";

const ORIGINAL_TZ = process.env.TZ;
const ORIGINAL_LANG = process.env.LANG;
const ORIGINAL_LC_ALL = process.env.LC_ALL;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
  process.env.LANG = ORIGINAL_LANG;
  process.env.LC_ALL = ORIGINAL_LC_ALL;
});

/** Rebuild every plain object with its keys in reverse insertion order. */
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item)) as unknown as T;
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) return value;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).reverse()) {
    reversed[key] = reverseKeys((value as Record<string, unknown>)[key]);
  }
  return reversed as T;
}

/** Compile one request and return the bytes a downstream stage would consume. */
async function compiledBytes(request: CompilePackActionRequestV1): Promise<[string, string]> {
  const compiled = await compilePackAction(request);
  return [compiled.planDocument, compiled.planDigest];
}

describe("plan compiler determinism", () => {
  it("compiles two independently built identical requests to the same bytes", async () => {
    const first = await compiledBytes(buildCompileRequest());
    const second = await compiledBytes(buildCompileRequest());
    expect(second).toEqual(first);
  });

  it("ignores the key order of the input, the pack maps, and the binding", async () => {
    const request = buildCompileRequest();
    const baseline = await compiledBytes({ ...request, input: { topic: "physics", depth: 3 } });
    const permuted = await compiledBytes(reverseKeys({ ...request, input: { depth: 3, topic: "physics" } }));
    expect(permuted).toEqual(baseline);
  });

  it("ignores the process time zone and locale", async () => {
    const baseline = await compiledBytes(buildCompileRequest());
    process.env.TZ = "Pacific/Kiritimati";
    process.env.LANG = "tr_TR.UTF-8";
    process.env.LC_ALL = "tr_TR.UTF-8";
    expect(await compiledBytes(buildCompileRequest())).toEqual(baseline);
  });

  it("compiles the same request repeatedly to the same bytes", async () => {
    const request = buildCompileRequest();
    const first = await compiledBytes(request);
    expect(await compiledBytes(request)).toEqual(first);
    expect(await compiledBytes(request)).toEqual(first);
  });

  it("moves the digest when an input value changes", async () => {
    const [document, digest] = await compiledBytes(buildCompileRequest());
    const changed = await compiledBytes({ ...buildCompileRequest(), input: { topic: "magnetism" } });
    expect(changed[1]).not.toBe(digest);
    expect(changed[0]).not.toBe(document);
  });

  it("moves the digest when a defaulted input is overridden", async () => {
    const [, digest] = await compiledBytes(buildCompileRequest());
    const overridden = await compiledBytes({
      ...buildCompileRequest(), input: { topic: "superconductivity", depth: 5 },
    });
    expect(overridden[1]).not.toBe(digest);
  });

  it("moves the digest when a different action is compiled", async () => {
    const [, digest] = await compiledBytes(buildCompileRequest());
    const request = buildCompileRequest();
    const action = request.pack.actions["demo.run"]!;
    request.pack.actions = { "demo.other": { ...action, actionId: "demo.other" } };
    expect((await compiledBytes({ ...request, actionId: "demo.other" }))[1]).not.toBe(digest);
  });

  it("moves the digest when the recipe or an authority changes", async () => {
    const [, digest] = await compiledBytes(buildCompileRequest());
    const retemplated = buildCompileRequest();
    const render = retemplated.pack.recipes[RECIPE_ID]!.phases[1]!;
    if (render.kind === "render") render.body.templateRef = "render.other-page";
    // The re-pointed ref must RESOLVE — compile now refuses an undeclared
    // template — so the alternate template is declared under the new name.
    retemplated.pack.renderTemplates = {
      ...retemplated.pack.renderTemplates,
      "render.other-page": {
        templateId: "render.other-page", version: "1.0.0",
        nodes: [{ kind: "literal", text: "other\n" }],
      },
    };
    expect((await compiledBytes(retemplated))[1]).not.toBe(digest);
    const rebound = buildCompileRequest();
    expect((await compiledBytes({
      ...rebound, safetyFloorDigest: rebound.binding.packageDigest,
    }))[1]).not.toBe(digest);
  });

  it("moves the digest when the invoked surface changes", async () => {
    const [, digest] = await compiledBytes(buildCompileRequest());
    const compiled = await compiledBytes({ ...buildCompileRequest(), requestedSurface: "sdk" });
    expect(compiled[1]).not.toBe(digest);
  });
});
