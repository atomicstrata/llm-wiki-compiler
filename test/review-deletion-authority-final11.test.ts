/**
 * @file test/review-deletion-authority-final11.test.ts
 * @description Decision 20 approval regressions require candidate namespace
 * authority to fail before default or typed live-page effects.
 */

import { access, chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCandidate } from "../src/compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../src/compiler/candidate-custody.js";
import { promoteStagedEntityPage, stageEntityPage } from "../src/trust/staging.js";
import { buildResearchLiteProject, RESEARCH_LITE_PROFILE } from "./fixtures/profile-fixtures.js";
import { validateProfile } from "../src/profile/validate.js";
import { expectCLIFailure, runCLI } from "./fixtures/run-cli.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();
const CAN_TEST_POSIX_MODES = process.platform !== "win32" && process.getuid?.() !== 0;

/** Install the stable archive-to-pending alias rejected by D-074. */
async function aliasArchive(): Promise<void> {
  const candidates = path.join(root.dir, ".llmwiki", "candidates");
  await mkdir(candidates, { recursive: true });
  await symlink(".", path.join(candidates, "archive"));
}

/** Default candidate body that passes live-page validation. */
function defaultBody(): string {
  return "---\ntitle: Authority\nsummary: safe\nsources: []\n---\n\n# Authority\n";
}

/** Run a real approval and prove it cannot publish the requested live page. */
async function expectApprovalRefusal(candidateId: string, livePath: string): Promise<void> {
  const result = await runCLI(["review", "approve", candidateId], root.dir);
  expectCLIFailure(result);
  expect(result.stdout).not.toContain("Approved");
  await expect(access(path.join(root.dir, livePath)))
    .rejects.toMatchObject({ code: "ENOENT" });
}

describe("Decision 20 approval namespace precondition", () => {
  it("real review approval refuses the alias before writing or success", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Authority", slug: "approval-authority", summary: "safe",
      sources: [], body: defaultBody(),
    });
    const pending = path.join(root.dir, ".llmwiki", "candidates", `${candidate.id}.json`);
    await aliasArchive();

    await expectApprovalRefusal(candidate.id, "wiki/concepts/approval-authority.md");
    expect(JSON.parse(await readFile(pending, "utf8")).id).toBe(candidate.id);
  }, 30_000);

  it.runIf(CAN_TEST_POSIX_MODES)("real approval refuses read-only pending before live writes", async () => {
    const candidate = await writeCandidate(root.dir, {
      title: "Read Only", slug: "read-only-approval", summary: "safe",
      sources: [], body: defaultBody(),
    });
    const candidates = path.join(root.dir, ".llmwiki", "candidates");
    const pending = path.join(candidates, `${candidate.id}.json`);
    await chmod(candidates, 0o555);

    try {
      await expectApprovalRefusal(candidate.id, "wiki/concepts/read-only-approval.md");
      expect(JSON.parse(await readFile(pending, "utf8")).id).toBe(candidate.id);
    } finally {
      await chmod(candidates, 0o700);
    }
  }, 30_000);

  it("shared typed promotion refuses the alias before SDK live writes", async () => {
    await buildResearchLiteProject(root.dir);
    const staged = await stageEntityPage(root.dir, {
      entityType: "papers", slug: "typed-authority", profile: validateProfile(RESEARCH_LITE_PROFILE).profile,
      body: "---\ntitle: Typed Authority\n---\n\n# Typed Authority\n", existingStagedCount: 0,
    });
    const pending = path.join(root.dir, ".llmwiki", "candidates", `${staged.id}.json`);
    await aliasArchive();

    await expect(promoteStagedEntityPage(root.dir, staged.id))
      // Public in-root aliases are allowed; sharing pending/archive custody is not.
      .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    await expect(access(path.join(root.dir, "wiki", "papers", "typed-authority.md")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(pending, "utf8")).id).toBe(staged.id);
  });

  it.runIf(CAN_TEST_POSIX_MODES)("typed promotion refuses read-only pending before live writes", async () => {
    await buildResearchLiteProject(root.dir);
    const staged = await stageEntityPage(root.dir, {
      entityType: "papers", slug: "typed-read-only", profile: validateProfile(RESEARCH_LITE_PROFILE).profile,
      body: "---\ntitle: Typed Read Only\n---\n\n# Typed Read Only\n", existingStagedCount: 0,
    });
    const candidates = path.join(root.dir, ".llmwiki", "candidates");
    await chmod(candidates, 0o555);

    try {
      await expect(promoteStagedEntityPage(root.dir, staged.id))
        .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
      await expect(access(path.join(root.dir, "wiki/papers/typed-read-only.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(candidates, 0o700);
    }
  });
});
