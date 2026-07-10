/**
 * @file test/query-save-profile-gate.test.ts
 * @description FIX #6 — `query --save` must be DISABLED in profile-enabled
 * (non-default-profile) projects, where the saved-query write path is not yet
 * Trust-Guard-routed (CLP plan D7 / spec-07). In a default project it still
 * saves exactly as before.
 *
 * These tests drive `maybeSaveQueryPage` directly (the gate that wraps
 * `saveQueryPage`) so they exercise the real save/disable decision without the
 * full LLM answer pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import { maybeSaveQueryPage } from "../src/commands/query.js";
import { setQuerySaveTestHookForTest } from "../src/commands/query-save.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { acquireLock, releaseLock } from "../src/utils/lock.js";

const QUESTION = "What is attention?";
const ANSWER = "Attention is a weighting mechanism over a sequence.";

describe("query --save profile gate", () => {
  let root: string;
  let originalCwd: string;

  beforeEach(async () => {
    root = await makeTempRoot("qsave-gate");
    originalCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("DEFAULT project: --save writes a queries page (unchanged)", async () => {
    const slug = await maybeSaveQueryPage(root, QUESTION, ANSWER, true);
    expect(slug).toBeDefined();
    expect(existsSync(path.join(root, "wiki/queries", `${slug}.md`))).toBe(true);
  });

  it("DEFAULT project: save decision and write hold the project lock", async () => {
    let lockWasHeld = false;
    setQuerySaveTestHookForTest(async () => {
      const acquired = await acquireLock(root, { quiet: true });
      lockWasHeld = !acquired;
      if (acquired) await releaseLock(root);
    });
    try {
      expect(await maybeSaveQueryPage(root, QUESTION, ANSWER, true)).toBeDefined();
    } finally {
      setQuerySaveTestHookForTest(undefined);
    }
    expect(lockWasHeld).toBe(true);
  });

  it("profile-enabled project: --save does NOT write a queries page", async () => {
    await buildResearchLiteProject(root);
    const slug = await maybeSaveQueryPage(root, QUESTION, ANSWER, true);
    expect(slug).toBeUndefined();
    const queries = await readdir(path.join(root, "wiki/queries"));
    expect(queries).toHaveLength(0);
  });

  it("save=false never writes regardless of profile", async () => {
    const slug = await maybeSaveQueryPage(root, QUESTION, ANSWER, false);
    expect(slug).toBeUndefined();
    const queries = await readdir(path.join(root, "wiki/queries"));
    expect(queries).toHaveLength(0);
  });
});
