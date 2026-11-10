/** Nested candidate identities survive approval without relaxing path confinement. */
import { afterEach, expect, it, vi } from "bun:test";
import { rm, writeFile, unlink, symlink } from "node:fs/promises";
import path from "node:path";
import { createDemo } from "./fixtures/source-review-project.js";
import { collectSourceReview } from "../src/viewer/source-review/report.js";
import { sourceExcerptReader } from "../src/viewer/source-review/source-excerpts.js";
import { sanitizeCandidate } from "../src/compiler/candidate-sanitize.js";
import approve from "../src/commands/review-approve.js";
import { readStateClassified } from "../src/utils/state.js";
import { detectChanges } from "../src/compiler/hasher.js";
import type { ReviewCandidate } from "../src/utils/types.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
/** Each test owns a disposable project, never an existing user's wiki. */
async function fixture() { const root = await createDemo(); roots.push(root); return root; }

it.each(["../escape.md", "a/../escape.md", "/absolute.md", "a//b.md", "a/./b.md", "a/..", "a/", "C:secret", "a\\b.md", "__proto__", "constructor", "\0.md"])("rejects unsafe state key %j", key => {
  const candidate = sanitizeCandidate({ generatedAt: "now", sourceStates: JSON.parse(JSON.stringify({
    [key]: { hash: "abc", concepts: [], compiledAt: "now" },
    "nested/safe.md": { hash: "ok", concepts: [], compiledAt: "now" },
  })) } as ReviewCandidate);
  expect(Object.hasOwn(candidate.sourceStates!, key)).toBe(false);
  expect(candidate.sourceStates!["nested/safe.md"].hash).toBe("ok");
});

it("approval records the nested hash and the next scan sees unchanged sources", async () => {
  const root = await fixture();
  const cwd = process.cwd();
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.chdir(root);
  try { await approve("timeout-proposal"); } finally { process.chdir(cwd); }
  const { state } = await readStateClassified(root);
  expect(state.sources["api/timeouts.md"].concepts).toContain("request-timeouts");
  const changes = await detectChanges(root, state);
  expect(changes.find(change => change.file === "api/timeouts.md")?.status).toBe("unchanged");
});

it("does not expose source bytes through an escaping symlink", async () => {
  const root = await fixture();
  const source = path.join(root, "sources/api/timeouts.md");
  await unlink(source);
  await symlink(path.join(root, ".llmwiki/state.json"), source);
  expect((await collectSourceReview(root)).pages[0].excerpts[0].text).toBeUndefined();
});

it("labels a shortened source excerpt while retaining line numbers", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "sources/api/timeouts.md"), "a\n".repeat(220));
  const excerpt = (await collectSourceReview(root)).pages[0].excerpts[0];
  expect(excerpt.truncated).toBe(true);
  expect(excerpt.text).toContain("200  a");
  expect(excerpt.text).not.toContain("201  a");
});

it("withholds an excerpt that no longer matches the source observation", async () => {
  const root = await fixture();
  const read = sourceExcerptReader(root, ["api/timeouts.md"]);
  const excerpt = await read("api/timeouts.md", "0".repeat(64));
  expect(excerpt.status).toBe("changed during this check; check files again");
  expect(excerpt.text).toBeUndefined();
});
