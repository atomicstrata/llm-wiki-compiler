/**
 * @file test/artifact-precondition-seam-invariant.test.ts
 * @description Anti-recurrence guard for the CLP Phase 7.3 Critical: the relation- and
 * artifact-precondition ENFORCERS must be CALLED from exactly ONE non-definition module,
 * the shared `src/trust/gated-state-entry.ts` seam. If a future write path calls either
 * enforcer directly (as the lifecycle-transition path once did, bypassing the artifact
 * check), it re-introduces the drift this slice closed and this test fails. A real
 * runtime scan of the `src/` tree — a call `name(` is matched, not an import or `{@link}`.
 */
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const SEAM = "trust/gated-state-entry.ts";
/** Each enforcer's own definition module — its `export function name(` is a definition, not a call. */
const DEFINITION_MODULES = new Set(["relations/enforce-precondition.ts", "artifacts/enforce-precondition.ts"]);
/** Matches a CALL to either enforcer (name immediately followed by `(`) — not an import/`{@link}`. */
const ENFORCER_CALL = /\benforce(?:Relation|Artifact)Preconditions\(/;

/** Every `.ts` file under `src/`, as paths relative to `src/`. */
async function srcFiles(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await srcFiles(abs, base)));
    else if (entry.name.endsWith(".ts")) out.push(path.relative(base, abs));
  }
  return out;
}

describe("precondition enforcers are called only through the shared seam", () => {
  it("finds enforcer CALLS in exactly the gated-state-entry seam module", async () => {
    const files = await srcFiles(SRC, SRC);
    const callers: string[] = [];
    for (const rel of files) {
      if (DEFINITION_MODULES.has(rel)) continue; // skip each enforcer's own definition
      const text = await readFile(path.join(SRC, rel), "utf8");
      if (ENFORCER_CALL.test(text)) callers.push(rel);
    }
    expect(callers.map((p) => p.split(path.sep).join("/"))).toEqual([SEAM]);
  });
});
