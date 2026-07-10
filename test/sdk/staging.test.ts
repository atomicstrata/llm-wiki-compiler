/**
 * @file test/sdk/staging.test.ts
 * @description Tests the EXPERIMENTAL `createWiki()` staging methods, which load
 * the active non-default profile INTERNALLY (the caller passes no ProfilePack).
 *
 * Over a project WITH a non-default profile, `stageEntityPage` creates a typed
 * candidate and `promoteStagedPage` lands the body at `wiki/<entityType>/<slug>.md`.
 * Over a DEFAULT project (no profile), `stageEntityPage` throws the clear
 * "requires a non-default profile" error.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { countCandidates } from "../../src/compiler/candidates.js";
import { createWiki } from "../../src/sdk/wiki.js";
import { StagingRequiresProfileError } from "../../src/trust/staging.js";
import { acquireLock, releaseLock } from "../../src/utils/lock.js";
import { buildResearchLiteProject } from "../fixtures/profile-fixtures.js";

let root = "";
const SLUG = "linear-attention";
const BODY = "---\ntitle: Linear Attention\n---\n\nStaged body.\n";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "sdk-staging-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createWiki staging (experimental)", () => {
  it("stages then promotes a typed page through the SDK facade", async () => {
    await buildResearchLiteProject(root);
    const wiki = createWiki({ root });

    const staged = await wiki.stageEntityPage({ entityType: "papers", slug: SLUG, body: BODY });
    expect(staged.target).toMatchObject({ entityType: "papers", slug: SLUG, id: `papers/${SLUG}` });

    await wiki.promoteStagedPage(staged.id);
    expect(await readFile(path.join(root, "wiki/papers", `${SLUG}.md`), "utf8")).toBe(BODY);
  });

  it("throws the requires-a-non-default-profile error on a default project", async () => {
    const wiki = createWiki({ root });
    await expect(
      wiki.stageEntityPage({ entityType: "papers", slug: SLUG, body: BODY }),
    ).rejects.toBeInstanceOf(StagingRequiresProfileError);
  });

  it("waits for the project lock before writing a staged candidate", async () => {
    await buildResearchLiteProject(root);
    const wiki = createWiki({ root });
    expect(await acquireLock(root, { quiet: true })).toBe(true);

    const staging = wiki.stageEntityPage({ entityType: "papers", slug: SLUG, body: BODY });
    await delay(75);
    expect(await countCandidates(root)).toBe(0);

    await releaseLock(root);
    await expect(staging).resolves.toMatchObject({ target: { entityType: "papers", slug: SLUG } });
    expect(await countCandidates(root)).toBe(1);
  });
});
