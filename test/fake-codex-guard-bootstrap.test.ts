/**
 * Generation-level checks for the fake Codex child guard bootstrap.
 *
 * These cases inspect generated program text only and start no processes, so
 * they add no unguarded children to a guarded run. They pin three properties:
 * an unconfigured run generates the original fake and descendant programs; a
 * configured run puts the guard prologue ahead of both programs' own code with
 * the configuration embedded; and any incomplete or invalid configuration fails
 * closed before a fake is installed. `inheritedNodeOptions`/`inheritedRuntimeOptions`
 * and `childGuardEnv` (the guard entries for explicitly minimal child environments)
 * are checked too, for each child runtime: Node children get `NODE_OPTIONS --import`,
 * Bun children `BUN_OPTIONS --preload`, and an unknown runtime fails closed.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";
import { afterEach } from "./config/storage-profile-hooks.js";
import { restoreEnv, stubEnv } from "./stubs.js";
import {
  CHILD_GUARD_ENV, childGuardEnv, childGuardPrologue, composeRuntimeOptions, executingRuntime, inheritedNodeOptions, inheritedRuntimeOptions,
  preloadFlag, shebangRuntime, type ChildRuntime,
} from "./fixtures/child-guard-bootstrap.js";
import { installFakeCodex, type FakeCodex } from "./fixtures/fake-codex.js";

const SHEBANG = "#!/usr/bin/env node\n";
const FAKE_BODY_START = 'const fs = require("node:fs");';
const DESCENDANT_BODY_START = 'process.on(\\"SIGTERM\\", () => {});';
const RUNTIMES: readonly ChildRuntime[] = ["node", "bun"];
const fakes: FakeCodex[] = [];
const roots: string[] = [];

/** Set every bootstrap variable, using undefined to remove one. */
function stubGuardEnv(values: Partial<Record<keyof typeof CHILD_GUARD_ENV, string | undefined>>): void {
  for (const [key, name] of Object.entries(CHILD_GUARD_ENV)) {
    stubEnv(name, values[key as keyof typeof CHILD_GUARD_ENV]);
  }
}

/** A fresh temporary root, removed after the case. */
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llmwiki-guard-bootstrap-"));
  roots.push(root);
  return root;
}

/** A complete, valid configuration naming files in a fresh temporary root (no runtime declaration: Node only). */
async function validConfig(): Promise<Record<Exclude<keyof typeof CHILD_GUARD_ENV, "runtimes">, string>> {
  const root = await freshRoot();
  const guard = path.join(root, "guard.mjs");
  await writeFile(guard, "export {};\n", "utf8");
  return {
    url: pathToFileURL(guard).href,
    log: path.join(root, "guard.jsonl"),
    denyExec: process.execPath,
    census: path.join(root, "census.jsonl"),
  };
}

/** Install a hanging, descendant-forking fake and return its generated program text. */
async function generatedProgram(): Promise<string> {
  const fake = await installFakeCodex({ hang: true, forkDescendant: true });
  fakes.push(fake);
  return readFile(path.join(fake.binDir, "codex"), "utf8");
}

afterEach(async () => {
  restoreEnv();
  await Promise.all(fakes.splice(0).map((fake) => fake.cleanup()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fake Codex child guard bootstrap", () => {
  it("generates the original programs when no bootstrap is configured", async () => {
    stubGuardEnv({});
    const program = await generatedProgram();
    expect(program.startsWith(SHEBANG + FAKE_BODY_START)).toBe(true);
    expect(program).toContain(`["-e", "${DESCENDANT_BODY_START}`);
    expect(program).not.toContain("child guard bootstrap");
    expect(childGuardPrologue(undefined, "fake")).toBe("");
  });

  it("guards the fake and its descendant ahead of their own code when configured", async () => {
    const config = await validConfig();
    stubGuardEnv(config);
    const program = await generatedProgram();
    const fakePrologue = childGuardPrologue(config, "fake");
    expect(program.startsWith(SHEBANG + fakePrologue + FAKE_BODY_START)).toBe(true);
    expect(fakePrologue).toContain(JSON.stringify({ ...config, role: "fake" }));
    const descendantPrologue = JSON.stringify(childGuardPrologue(config, "descendant")).slice(1, -1);
    expect(program).toContain(`["-e", "${descendantPrologue}${DESCENDANT_BODY_START}`);
    expect(descendantPrologue).toContain(JSON.stringify(JSON.stringify({ ...config, role: "descendant" })).slice(1, -1));
  });

  it.each([
    { label: "a log without a guard module", change: { url: undefined } },
    { label: "a non-file guard URL", change: { url: "https://example.invalid/guard.mjs" } },
    { label: "a missing guard module", change: { url: pathToFileURL("/nonexistent/llmwiki-guard.mjs").href } },
    { label: "a relative log path", change: { log: "guard.jsonl" } },
    { label: "an empty deny list", change: { denyExec: "" } },
    { label: "a relative census path", change: { census: "census.jsonl" } },
    { label: "a runtime declaration without node", change: { runtimes: "bun" } },
    { label: "an unknown declared runtime", change: { runtimes: "node,deno" } },
    { label: "a repeated declared runtime", change: { runtimes: "node,node" } },
  ])("fails closed on $label", async ({ change }) => {
    stubGuardEnv({ ...(await validConfig()), ...change });
    await expect(installFakeCodex()).rejects.toThrow(/child guard bootstrap/);
    for (const runtime of RUNTIMES) expect(() => childGuardEnv(runtime)).toThrow(/child guard bootstrap/);
  });
});

// The same suite title continues in short blocks, so every case keeps its full name.
describe("fake Codex child guard bootstrap", () => {
  it("gives an explicit child environment no guard entries when unconfigured", () => {
    stubGuardEnv({});
    for (const runtime of RUNTIMES) expect(childGuardEnv(runtime)).toEqual({});
  });

  it("gives an explicit child environment exactly the configured guard and its two settings", async () => {
    const config = await validConfig();
    stubGuardEnv(config);
    expect(childGuardEnv("node")).toStrictEqual({
      NODE_OPTIONS: `--import=${config.url}`,
      OFFLINE_GUARD_LOG: config.log,
      OFFLINE_GUARD_DENY_EXEC: config.denyExec,
    });
    // A guard module that does not declare Bun coverage never reaches a Bun child as if it were complete.
    expect(() => childGuardEnv("bun")).toThrow(/does not cover bun children/);
    stubGuardEnv({ ...config, runtimes: "node,bun" });
    expect(childGuardEnv("node")).toStrictEqual({ NODE_OPTIONS: `--import=${config.url}`, OFFLINE_GUARD_LOG: config.log, OFFLINE_GUARD_DENY_EXEC: config.denyExec });
    expect(childGuardEnv("bun")).toStrictEqual({
      BUN_OPTIONS: `--preload=${fileURLToPath(config.url)}`,
      OFFLINE_GUARD_LOG: config.log,
      OFFLINE_GUARD_DENY_EXEC: config.denyExec,
    });
  });

  it("fails closed on an unknown or missing child runtime, configured or not", async () => {
    stubGuardEnv({});
    for (const runtime of ["deno", "", undefined]) expect(() => childGuardEnv(runtime as ChildRuntime)).toThrow(/unknown child runtime/);
    stubGuardEnv(await validConfig());
    expect(() => childGuardEnv("deno" as ChildRuntime)).toThrow(/unknown child runtime/);
  });
});

describe("fake Codex child guard bootstrap", () => {
  it("adds preloads after the inherited NODE_OPTIONS instead of replacing them", () => {
    stubEnv("NODE_OPTIONS", "--import=file:///inherited/guard.mjs");
    expect(inheritedNodeOptions("--import=/test/preload.mjs"))
      .toBe("--import=file:///inherited/guard.mjs --import=/test/preload.mjs");
    stubEnv("NODE_OPTIONS", undefined);
    expect(inheritedNodeOptions("--import=/test/preload.mjs")).toBe("--import=/test/preload.mjs");
  });

  it("adds preloads after the inherited BUN_OPTIONS for a Bun child, never mixing the two variables", () => {
    stubEnv("NODE_OPTIONS", "--import=file:///inherited/node-guard.mjs");
    stubEnv("BUN_OPTIONS", "--preload=/inherited/bun-guard.mjs");
    expect(inheritedRuntimeOptions("bun", "--preload=/test/preload.mjs")).toBe("--preload=/inherited/bun-guard.mjs --preload=/test/preload.mjs");
    stubEnv("BUN_OPTIONS", undefined);
    expect(inheritedRuntimeOptions("bun", "--preload=/test/preload.mjs")).toBe("--preload=/test/preload.mjs");
  });

  it("reads a generated script's runtime from its #! line and refuses anything else", async () => {
    const root = await freshRoot();
    const cases: Array<[string, ChildRuntime | undefined]> = [
      ["#!/usr/bin/env node\n", "node"], ["#!/usr/bin/env -S bun --smol\n", "bun"], ["#!/opt/node/bin/node\n", "node"],
      ["#!/bin/sh\n", undefined], ["console.log(1);\n", undefined],
    ];
    for (const [index, [text, runtime]] of cases.entries()) {
      const script = path.join(root, `script-${index}`);
      await writeFile(script, text, "utf8");
      if (runtime) expect(shebangRuntime(script)).toBe(runtime);
      else expect(() => shebangRuntime(script)).toThrow(/unknown child runtime/);
    }
    expect(shebangRuntime(path.join((await generatedProgramDir()), "codex"))).toBe("node");
    expect(executingRuntime()).toBe(typeof process.versions.bun === "string" ? "bun" : "node");
  });
});

describe("fake Codex child guard bootstrap", () => {
  it("keeps inherited options byte for byte and de-duplicates only the generated flags", () => {
    const guard = "--preload=/run/guard.mjs";
    const quoted = `--require "/tmp/a  b/x.js"   --conditions dev --conditions dev`;
    expect(composeRuntimeOptions(quoted, guard, guard, "--preload=/test/mock.mjs")).toBe(`${quoted} ${guard} --preload=/test/mock.mjs`);
    expect(composeRuntimeOptions(undefined, guard)).toBe(guard);
    expect(composeRuntimeOptions(" ", guard)).toBe(`  ${guard}`);
    // An inherited copy of a generated preload is not guessed away: the guard's marker makes the repeat a no-op.
    stubEnv("BUN_OPTIONS", guard);
    expect(inheritedRuntimeOptions("bun", guard)).toBe(`${guard} ${guard}`);
    for (const bad of ["", "--preload=/a b.mjs"]) expect(() => composeRuntimeOptions(undefined, bad)).toThrow(/child guard bootstrap/);
  });

  it("refuses a preload path that an options variable would split or misquote", () => {
    for (const runtime of RUNTIMES) {
      for (const unsafe of ["/tmp/a b/guard.mjs", "/tmp/a\"b.mjs", "/tmp/a'b.mjs", "/tmp/a\\b.mjs", "relative/guard.mjs"]) {
        expect(() => preloadFlag(runtime, unsafe)).toThrow(/child guard bootstrap/);
      }
      expect(preloadFlag(runtime, "/tmp/guard.mjs")).toBe(runtime === "node" ? "--import=file:///tmp/guard.mjs" : "--preload=/tmp/guard.mjs");
    }
  });
});

/** Install an unconfigured fake and return its bin directory (its generated `codex` has a Node `#!` line). */
async function generatedProgramDir(): Promise<string> {
  stubGuardEnv({});
  const fake = await installFakeCodex();
  fakes.push(fake);
  return fake.binDir;
}
