/**
 * @file test/operation-bundles/runtime-factory.test.ts
 * @description The structural authority split of the runtime factory: the generic
 * builder is fail-closed by default (installs the refusing provider unless an
 * authority is explicitly injected), and only the CLI-dedicated constructor
 * installs the production operations-authority resolver. This pins that a caller
 * cannot gain operation authority merely by calling the generic factory.
 */

import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { createOperationRuntime, createCliOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import { refusingAuthorityProvider } from "../../src/operation-bundles/authority.js";
import { authorityRequestFor, fixtureAuthority, stageSourceBundle } from "./executor-fixtures.js";

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "op-runtime-factory-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("createOperationRuntime — fail closed by default", () => {
  it("installs the refusing provider when no authority is injected", () => {
    expect(createOperationRuntime().authority).toBe(refusingAuthorityProvider);
  });

  it("installs an explicitly injected authority provider unchanged", () => {
    const authority = fixtureAuthority();
    expect(createOperationRuntime({ authority }).authority).toBe(authority);
  });
});

describe("createCliOperationRuntime — production resolver", () => {
  it("installs a real resolver, never the refusing provider", () => {
    expect(createCliOperationRuntime().authority).not.toBe(refusingAuthorityProvider);
  });

  it("computes an ok snapshot over a staged root", async () => {
    const staged = await stageSourceBundle(root);
    const result = await createCliOperationRuntime().authority.computeSnapshot(await authorityRequestFor(root, staged));
    expect(result.status).toBe("ok");
  });
});
