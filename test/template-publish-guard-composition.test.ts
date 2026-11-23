/**
 * @file test/template-publish-guard-composition.test.ts
 * @description How the publisher verifier child's preload variable is composed by the
 * template-publish fixture. The child is `process.execPath`, so the variable is the
 * executing runtime's (`BUN_OPTIONS` under Bun, `NODE_OPTIONS` under Node). Unconfigured
 * runs load only the fixture's local execution guard, even when the parent has its own
 * ambient preloads (of either runtime, both dropped). A run that configures the child guard
 * bootstrap loads its explicit offline guard first and the local guard last, with the guard's
 * two settings and every other fixture field kept. A partial configuration fails before any
 * child could be launched. Only the constructed environment is checked here; process-level
 * effectiveness is shown by the run's private controls.
 */
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach } from "./config/storage-profile-hooks.js";
import { restoreEnv, stubEnv } from "./stubs.js";
import { CHILD_GUARD_ENV, executingRuntime, preloadFlag, runtimeOptionsVariable } from "./fixtures/child-guard-bootstrap.js";
import { guardRoots } from "./fixtures/guard-root.js";
import { offlineEnvironment } from "./fixtures/template-publish-distribution.js";

const AMBIENT_NODE_OPTIONS = "--import=file:///ambient/preload.mjs";
const AMBIENT_BUN_OPTIONS = "--preload=/ambient/preload.mjs";
const RUNTIME = executingRuntime();
const VARIABLE = runtimeOptionsVariable(RUNTIME);
const OTHER_VARIABLE = VARIABLE === "BUN_OPTIONS" ? "NODE_OPTIONS" : "BUN_OPTIONS";
const roots = guardRoots("llmwiki-publish-guard-", "outer-guard.mjs");

afterEach(async () => {
  restoreEnv();
  await roots.cleanup();
});

/** A fresh root, its local guard preload flag, and a valid child guard configuration under it. */
async function fixtureRoot() {
  const { root, url, log } = await roots.create();
  const local = preloadFlag(RUNTIME, path.join(root, "execution-guard.mjs"));
  // The configured entry declares both runtimes, as the harness's runtime-aware combined entry does.
  const config = { url, log, denyExec: process.execPath, runtimes: "node,bun" };
  return { root, local, config };
}

/** Set (or remove, with undefined) every child guard bootstrap variable. */
function stubGuard(config: { url?: string; log?: string; denyExec?: string; runtimes?: string } = {}): void {
  stubEnv(CHILD_GUARD_ENV.url, config.url);
  stubEnv(CHILD_GUARD_ENV.log, config.log);
  stubEnv(CHILD_GUARD_ENV.denyExec, config.denyExec);
  stubEnv(CHILD_GUARD_ENV.census, undefined);
  stubEnv(CHILD_GUARD_ENV.runtimes, config.runtimes);
}

/** Give the parent ambient preloads of both runtimes. */
function stubAmbientPreloads(): void {
  stubEnv("NODE_OPTIONS", AMBIENT_NODE_OPTIONS);
  stubEnv("BUN_OPTIONS", AMBIENT_BUN_OPTIONS);
}

describe("template-publish verifier guard composition", () => {
  it("loads only the local guard when unconfigured, ignoring ambient preloads", async () => {
    const { root, local } = await fixtureRoot();
    stubGuard();
    stubAmbientPreloads();
    const env = offlineEnvironment(root);
    expect(env[VARIABLE]).toBe(local);
    expect(env[OTHER_VARIABLE]).toBeUndefined();
    expect(env.HOME).toBe(path.join(root, "environment", "home"));
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:1");
  });

  it("loads a configured offline guard first and the local guard last, keeping the fixture fields", async () => {
    const { root, local, config } = await fixtureRoot();
    stubGuard(config);
    stubAmbientPreloads();
    const env = offlineEnvironment(root);
    expect(env[VARIABLE]).toBe(`${preloadFlag(RUNTIME, config.url)} ${local}`);
    expect(env[OTHER_VARIABLE]).toBeUndefined();
    expect(env.OFFLINE_GUARD_LOG).toBe(config.log);
    expect(env.OFFLINE_GUARD_DENY_EXEC).toBe(config.denyExec);
    expect(env.TMPDIR).toBe(path.join(root, "environment", "tmp"));
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:1");
  });

  it("fails before launch on a partial child guard configuration", async () => {
    const { root, config } = await fixtureRoot();
    stubGuard({ url: config.url });
    expect(() => offlineEnvironment(root)).toThrow(/child guard bootstrap/);
  });
});

describe("template-publish verifier guard composition", () => {
  it("fails before launch when the configured guard does not declare the verifier's runtime", async () => {
    const { root, config } = await fixtureRoot();
    stubGuard({ ...config, runtimes: RUNTIME === "bun" ? "node" : undefined });
    if (RUNTIME === "bun") expect(() => offlineEnvironment(root)).toThrow(/does not cover bun children/);
    else expect(offlineEnvironment(root)[VARIABLE]).toContain(preloadFlag(RUNTIME, config.url));
  });
});
