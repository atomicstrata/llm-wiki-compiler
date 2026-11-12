/**
 * CLI-level integration tests for claim-level provenance lint rules.
 *
 * These tests run `bun dist/cli.js lint` against temporary wiki fixtures
 * and assert on exit codes and stdout content. They cover the two new rules
 * (`broken-citation` with span suffixes and `malformed-claim-citation`) as
 * well as backward-compat scenarios where no new findings should appear.
 *
 * dist/cli.js is built once by `bun run test` before the suite starts.
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { CLI_RUNTIME_FLAGS, exec, CLI, stripAnsi } from "./fixtures/run-cli.js";

/** Set up a minimal llmwiki project root with wiki/concepts, wiki/queries, sources. */
async function createWikiRoot(suffix: string): Promise<string> {
  const root = path.join(tmpdir(), `llmwiki-int-${suffix}-${Date.now()}`);
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await mkdir(path.join(root, "wiki/queries"), { recursive: true });
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

/** Write a wiki concept page. */
async function writeConcept(root: string, slug: string, content: string): Promise<void> {
  await writeFile(path.join(root, "wiki/concepts", `${slug}.md`), content);
}

/** Write a sources file. */
async function writeSource(root: string, name: string, content: string): Promise<void> {
  await writeFile(path.join(root, "sources", name), content);
}

/** Run `llmwiki lint` in a given directory. Returns stdout and exit code. */
async function runLint(cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await exec(process.execPath, [...CLI_RUNTIME_FLAGS, CLI, "lint"], { cwd });
    return { stdout: stripAnsi(stdout), exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; code?: number };
    return { stdout: stripAnsi(error.stdout ?? ""), exitCode: error.code ?? 1 };
  }
}

describe("CLI integration — claim-level provenance lint rules", () => {
  it("reports broken-citation for an unresolved span reference", async () => {
    const root = await createWikiRoot("broken-span");
    try {
      await writeConcept(
        root,
        "broken",
        "---\ntitle: Broken Span\n---\nA claim. ^[unknown.md:1-5]",
      );

      const { stdout, exitCode } = await runLint(root);

      expect(exitCode).toBe(1);
      // The CLI prints the message text; the rule name does not appear literally.
      expect(stdout).toContain("Broken citation");
      expect(stdout).toContain("unknown.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports malformed-claim-citation for non-numeric line ranges", async () => {
    const root = await createWikiRoot("malformed-span");
    try {
      await writeConcept(
        root,
        "malformed",
        "---\ntitle: Malformed Citation\n---\nA claim. ^[file.md:abc-xyz]",
      );

      const { stdout, exitCode } = await runLint(root);

      expect(exitCode).toBe(1);
      // The CLI prints the message text from the rule result.
      expect(stdout).toContain("Malformed claim citation");
      expect(stdout).toContain("file.md:abc-xyz");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("produces no provenance findings for legacy paragraph-form citations", async () => {
    const root = await createWikiRoot("paragraph-only");
    try {
      await writeSource(root, "ref.md", "# Reference\nSource content.");
      await writeConcept(
        root,
        "legacy",
        "---\ntitle: Legacy\nsummary: Uses only paragraph citations.\n---\n" +
          "A paragraph citation. ^[ref.md] That is fine for backward compat.",
      );

      const { stdout, exitCode } = await runLint(root);
      const provenanceFindings = stdout
        .split("\n")
        .filter((l) => l.includes("broken-citation") || l.includes("malformed-claim-citation"));

      expect(exitCode).toBe(0);
      expect(provenanceFindings).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("produces no findings when paragraph and claim citations all resolve correctly", async () => {
    const root = await createWikiRoot("mixed-clean");
    try {
      await writeSource(root, "src.md", "# Source\nLine 2\nLine 3\nLine 4\nLine 5");
      await writeConcept(
        root,
        "clean",
        "---\ntitle: Clean Mix\nsummary: Mixed citation forms that all resolve.\n---\n" +
          "Paragraph form. ^[src.md]\n\nClaim with colon range. ^[src.md:2-4]\n\n" +
          "Claim with hash range. ^[src.md#L3-L5]",
      );

      const { stdout, exitCode } = await runLint(root);

      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("broken-citation");
      expect(stdout).not.toContain("malformed-claim-citation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("summary line shows error and warning counts so users see lint ran", async () => {
    const root = await createWikiRoot("rule-names");
    try {
      await writeConcept(
        root,
        "check",
        "---\ntitle: Rule Names\n---\nClaim. ^[missing.md:1-5]",
      );

      const { stdout } = await runLint(root);

      // The summary line always appears so users know the linter ran.
      expect(stdout).toMatch(/\d+ error\(s\)/);
      expect(stdout).toMatch(/\d+ warning\(s\)/);
      // The broken-citation rule message must appear in the output.
      expect(stdout).toContain("Broken citation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("end-to-end: findings shape includes rule, file, and message fields in stdout", async () => {
    const root = await createWikiRoot("e2e-shape");
    try {
      await writeConcept(
        root,
        "e2e",
        "---\ntitle: E2E\n---\nClaim A. ^[gone.md:10-20]\n\nClaim B. ^[bad.md:nope]",
      );

      const { stdout, exitCode } = await runLint(root);

      // Exit code 1 because errors exist.
      expect(exitCode).toBe(1);

      // Both rule messages must appear in the diagnostic output.
      expect(stdout).toContain("Broken citation");
      expect(stdout).toContain("Malformed claim citation");

      // The diagnostic output must reference the file under lint.
      expect(stdout).toContain("e2e.md");

      // The summary line must report error counts.
      expect(stdout).toMatch(/\d+ error\(s\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
