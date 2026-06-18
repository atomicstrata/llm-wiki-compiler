/**
 * @file test/trust-checks.test.ts
 * @description Unit coverage for the MANDATORY CORE CHECKS over a page mutation
 * (`src/trust/checks.ts`) — the unconditional trust floor of CLP Invariant 3.
 *
 * These tests pin the four core checks (path-confinement, collision/no-overwrite,
 * resource-limit, frontmatter-parse) against a real tmp-dir fixture, then assert
 * the Invariant-3 floor itself: `runMandatoryPageChecks` runs ALL four checks
 * with no parameter by which a profile could gate or remove any of them. A
 * profile that *tries* to disable a check has no effect, because the runner takes
 * only the page-write context — there is no predicate, allow/deny list, or
 * profile argument in its signature.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { MAX_SOURCE_CHARS } from "../src/utils/constants.js";
import {
  checkPathConfinement,
  checkTargetCollision,
  checkResourceLimit,
  checkFrontmatter,
  mandatoryPageChecks,
  runMandatoryPageChecks,
  type PageWriteContext,
} from "../src/trust/checks.js";

let root: string;
const WIKI = "wiki/concepts";
const GOOD_BODY = "---\ntitle: Ok\n---\n\nbody\n";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "trust-checks-"));
  await mkdir(path.join(root, WIKI), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(targetPath: string, body = GOOD_BODY): PageWriteContext {
  return { root, targetPath, body };
}

describe("checkPathConfinement", () => {
  it("blocks a target that escapes the root", async () => {
    const res = await checkPathConfinement(ctx("../escape.md"));
    expect(res.verdict).toBe("block");
    expect(res.code).toBe("path-escape");
  });

  it("passes a target confined under the root", async () => {
    const res = await checkPathConfinement(ctx(`${WIKI}/page.md`));
    expect(res.verdict).toBe("pass");
  });

  it("blocks a target whose ancestor symlink escapes the root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "trust-outside-"));
    await symlink(outside, path.join(root, "wiki/link"), "dir");
    const res = await checkPathConfinement(ctx("wiki/link/page.md"));
    expect(res.verdict).toBe("block");
    expect(res.code).toBe("path-escape");
    await rm(outside, { recursive: true, force: true });
  });
});

describe("checkTargetCollision", () => {
  it("blocks when the target file already exists (create-only)", async () => {
    await writeFile(path.join(root, WIKI, "dup.md"), GOOD_BODY);
    const res = await checkTargetCollision(ctx(`${WIKI}/dup.md`));
    expect(res.verdict).toBe("block");
    expect(res.code).toBe("target-exists");
  });

  it("passes when the target path is free", async () => {
    const res = await checkTargetCollision(ctx(`${WIKI}/free.md`));
    expect(res.verdict).toBe("pass");
  });
});

describe("checkResourceLimit", () => {
  it("blocks a body exceeding the reused byte cap", async () => {
    const res = await checkResourceLimit(ctx(`${WIKI}/big.md`, "x".repeat(MAX_SOURCE_CHARS + 1)));
    expect(res.verdict).toBe("block");
    expect(res.code).toBe("resource-limit");
  });

  it("passes a body within the cap", async () => {
    const res = await checkResourceLimit(ctx(`${WIKI}/small.md`, "x".repeat(MAX_SOURCE_CHARS)));
    expect(res.verdict).toBe("pass");
  });
});

describe("checkFrontmatter", () => {
  it("blocks a malformed-frontmatter body", async () => {
    const bad = "---\ntitle: : : bad\n  nope\n---\n\nbody\n";
    const res = await checkFrontmatter(ctx(`${WIKI}/bad.md`, bad));
    expect(res.verdict).toBe("block");
    expect(res.code).toBe("frontmatter-invalid");
  });

  it("passes a well-formed frontmatter body", async () => {
    const res = await checkFrontmatter(ctx(`${WIKI}/ok.md`));
    expect(res.verdict).toBe("pass");
  });
});

describe("runMandatoryPageChecks (Invariant-3 floor)", () => {
  it("returns one result per registered check", async () => {
    const results = await runMandatoryPageChecks(ctx(`${WIKI}/page.md`));
    expect(results).toHaveLength(mandatoryPageChecks.length);
    expect(results.every((r) => typeof r.code === "string")).toBe(true);
  });

  it("runs ALL checks even when a profile tries to disable some", async () => {
    // A profile-shaped object asking to drop checks is structurally inert: the
    // runner accepts ONLY PageWriteContext, so there is no parameter through
    // which the profile could remove a core check. We attach it to the context
    // and confirm every mandatory check still ran on the failing input.
    const profileTryingToDisable = { disableChecks: ["path-escape", "resource-limit"] };
    const failing = { ...ctx("../escape.md", "x".repeat(MAX_SOURCE_CHARS + 1)), profileTryingToDisable };
    const results = await runMandatoryPageChecks(failing);
    const blocked = results.filter((r) => r.verdict === "block").map((r) => r.code);
    expect(blocked).toContain("path-escape");
    expect(blocked).toContain("resource-limit");
    expect(results).toHaveLength(mandatoryPageChecks.length);
  });
});
