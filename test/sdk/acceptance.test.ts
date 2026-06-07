/**
 * @file test/sdk/acceptance.test.ts
 * @description Acceptance tests for the `createWiki` SDK facade (Task 11).
 *
 * These tests are MANDATORY deterministic gates — they run without LLM
 * credentials and exercise the provider-gating contract, root isolation,
 * and schema shape of the exported document.  No real API calls are made.
 *
 * Credential removal strategy: deleting the explicit env vars is not
 * sufficient on its own because `resolveAnthropicAuthFromEnv` also falls
 * back to `~/.claude/settings.json`.  Each test that needs credential-free
 * execution also sets `LLMWIKI_CLAUDE_SETTINGS_PATH` to a non-existent
 * path so the file-read returns undefined and the fallback chain is severed.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";
import { ProviderUnavailableError, UnknownProviderError } from "../../src/utils/provider-guard.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

/** Remove all Anthropic credentials and sever the Claude settings file fallback. */
function stripAnthropicCreds(): void {
  process.env.LLMWIKI_PROVIDER = "anthropic";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  // Sever the ~/.claude/settings.json fallback so CI passes without a settings file.
  process.env.LLMWIKI_CLAUDE_SETTINGS_PATH = path.join(tmpdir(), "no-such-settings-llmwiki-test.json");
}

/** Assert that a promise does NOT reject with `ProviderUnavailableError`.
 *  If it rejects for an unrelated reason (e.g. empty root, missing index) that is
 *  acceptable — we only care that the credential guard was not the cause. */
async function expectNotProviderUnavailable(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
  }
}

describe("SDK acceptance", () => {
  it("compile throws ProviderUnavailableError without creds (mandatory gate)", async () => {
    stripAnthropicCreds();
    const root = await mkdtemp(path.join(tmpdir(), "wiki-acc-"));
    await expect(createWiki({ root }).compile()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("search throws ProviderUnavailableError without creds (mandatory gate)", async () => {
    stripAnthropicCreds();
    const root = await mkdtemp(path.join(tmpdir(), "wiki-search-"));
    await expect(createWiki({ root }).search("any question")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("query throws ProviderUnavailableError without creds (mandatory gate)", async () => {
    stripAnthropicCreds();
    const root = await mkdtemp(path.join(tmpdir(), "wiki-query-"));
    await expect(createWiki({ root }).query("any question")).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("runEval({ mode: 'full' }) throws ProviderUnavailableError without creds (mandatory gate)", async () => {
    stripAnthropicCreds();
    const root = await mkdtemp(path.join(tmpdir(), "wiki-eval-full-"));
    await expect(createWiki({ root }).runEval({ mode: "full" })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("runEval({ mode: 'fast' }) does NOT throw ProviderUnavailableError (credential-free)", async () => {
    stripAnthropicCreds();
    const root = await mkdtemp(path.join(tmpdir(), "wiki-eval-fast-"));
    // Fast mode is not provider-gated; may fail for unrelated reasons on an empty root.
    await expectNotProviderUnavailable(createWiki({ root }).runEval({ mode: "fast" }));
  });

  it("compile throws UnknownProviderError for an unsupported provider", async () => {
    process.env.LLMWIKI_PROVIDER = "bogus";
    const root = await mkdtemp(path.join(tmpdir(), "wiki-unknown-prov-"));
    await expect(createWiki({ root }).compile()).rejects.toBeInstanceOf(UnknownProviderError);
  });

  it("getContextPack does NOT throw ProviderUnavailableError (lexical fallback)", async () => {
    stripAnthropicCreds();
    const root = await mkdtemp(path.join(tmpdir(), "wiki-ctx-"));
    // Lexical retrieval works credential-free; may resolve to an empty pack or
    // reject for an unrelated reason (no compiled index) on an empty root.
    await expectNotProviderUnavailable(createWiki({ root }).getContextPack({ prompt: "x" }));
  });

  it("two clients on different roots do not cross-write (root isolation)", async () => {
    const a = await mkdtemp(path.join(tmpdir(), "wiki-a-"));
    const b = await mkdtemp(path.join(tmpdir(), "wiki-b-"));
    await createWiki({ root: a }).ingestText({ title: "A", text: "x" });
    await createWiki({ root: b }).ingestText({ title: "B", text: "y" });
    expect((await readdir(path.join(a, "sources"))).length).toBe(1);
    expect((await readdir(path.join(b, "sources"))).length).toBe(1);
  });

  it("exportJson returns a typed object", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-exp2-"));
    const doc = await createWiki({ root }).exportJson();
    expect(doc).toMatchObject({ schemaVersion: 1, pageCount: expect.any(Number) });
    expect(Array.isArray(doc.pages)).toBe(true);
  });
});
