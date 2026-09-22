/**
 * @file test/candidate-final6-ingress.test.ts
 * @description Final6 candidate identity regressions prove primitive,
 * well-formed, bounded validation occurs before every mutation-store ingress.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteCandidateBySlug,
  UnsafeCandidateIdError,
  writeCandidate,
} from "../src/compiler/candidates.js";
import {
  archivePath,
  assertCandidateId,
  assertCandidateSlug,
  candidatePath,
} from "../src/compiler/candidate-paths.js";
import { stageEntityPage } from "../src/trust/staging.js";
import { validateProfile } from "../src/profile/validate.js";
import { CANDIDATES_DIR } from "../src/utils/constants.js";
import { RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const BODY = "---\ntitle: Final6 Fixture\n---\nBody\n";

/** Build the minimum candidate draft for a runtime slug. */
function draftFor(slug: unknown) {
  return {
    title: "Final6 Fixture",
    slug,
    summary: "",
    sources: [],
    body: BODY,
  } as Parameters<typeof writeCandidate>[1];
}

/** Plant a regular-file sentinel where the candidate directory would be. */
async function plantCandidateStoreSentinel(): Promise<string> {
  const file = path.join(root.dir, CANDIDATES_DIR);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "STORE-SENTINEL");
  return file;
}

/** Stage one page using the supplied runtime slug. */
function stageWithSlug(slug: unknown): Promise<unknown> {
  return stageEntityPage(root.dir, {
    entityType: "papers",
    slug: slug as string,
    body: BODY,
    profile: validateProfile(RESEARCH_LITE_PROFILE).profile,
    existingStagedCount: 0,
  });
}

describe("Final6 candidate mutation ingress", () => {
  it("rejects non-string values without invoking proxy hooks", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const values = [null, 7, Symbol("candidate"), Object("boxed"), revoked.proxy];

    for (const value of values) {
      expect(() => (assertCandidateId as (input: unknown) => void)(value))
        .toThrow(UnsafeCandidateIdError);
      expect(() => (assertCandidateSlug as (input: unknown) => void)(value))
        .toThrow(UnsafeCandidateIdError);
    }
  });

  it.each(["\ud800", "\udfff"])("rejects lone surrogate %j on every path", async (surrogate) => {
    const id = `candidate-${surrogate}`;

    await expect(writeCandidate(root.dir, draftFor(id))).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    const pathResolvers = [candidatePath, archivePath];
    for (const resolvePath of pathResolvers) {
      await expect(resolvePath(root.dir, id)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
    }
    expect(existsSync(path.join(root.dir, CANDIDATES_DIR))).toBe(false);
  });

  it("preserves an explicit replacement character as a distinct accepted identity", async () => {
    const created = await writeCandidate(root.dir, draftFor("candidate-\ufffd"));
    const dir = path.join(root.dir, CANDIDATES_DIR);
    const [name] = (await readdir(dir)).filter((entry) => entry.endsWith(".json"));
    const persisted = JSON.parse(await readFile(path.join(dir, name!), "utf8"));

    expect(name).toBe(`${created.id}.json`);
    expect(persisted.id).toBe(created.id);
    expect(created.id).toContain("\ufffd");
  });

  it.each(["a".repeat(221), `${"é".repeat(110)}a`])(
    "validates stage slug before candidate-store access",
    async (slug) => {
      const sentinel = await plantCandidateStoreSentinel();

      await expect(stageWithSlug(slug)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
      expect(await readFile(sentinel, "utf8")).toBe("STORE-SENTINEL");
    },
  );

  it.each(["a".repeat(221), `${"é".repeat(110)}a`])(
    "validates delete slug before candidate-store access",
    async (slug) => {
      const sentinel = await plantCandidateStoreSentinel();

      await expect(deleteCandidateBySlug(root.dir, slug)).rejects.toBeInstanceOf(UnsafeCandidateIdError);
      expect(await readFile(sentinel, "utf8")).toBe("STORE-SENTINEL");
    },
  );
});
