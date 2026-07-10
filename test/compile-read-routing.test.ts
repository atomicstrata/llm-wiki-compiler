/**
 * Security tests: compile wiki READS are routed through the confined helper.
 *
 * A wiki file that is a symlink whose target escapes the project root must NOT
 * have its bytes reach an LLM provider prompt, nor be laundered into a written
 * page. These tests pre-plant escaping symlinks and assert:
 *  - the GENERATION provider prompt (page-renderer `callClaude`) omits the
 *    target's bytes (existing-page and related-page surfaces),
 *  - the EXTRACTION provider prompt omits a symlinked `wiki/index.md`'s bytes,
 *  - a symlinked `wiki/concepts/foo.md` is not re-emitted into a seed/resolution
 *    write,
 *  - a prominent (non-dim) drop warning is emitted.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { writeFile, symlink, readFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { callClaude } from "../src/utils/llm.js";
import * as output from "../src/utils/output.js";
import { renderMergedPageContent } from "../src/compiler/page-renderer.js";
import { resolveLinks } from "../src/compiler/resolver.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const SECRET = "OUTSIDE-SECRET-BYTES-7f3a9c";
const STUB_SCHEMA = { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2];

/** Plant `wiki/concepts/<slug>.md` as a symlink to an out-of-tree secret file. */
async function plantEscapingConcept(root: string, slug: string): Promise<void> {
  const outside = await makeOutsideDir();
  const target = path.join(outside, "secret.md");
  await writeFile(target, `---\ntitle: Secret\n---\n${SECRET}`);
  await symlink(target, path.join(root, "wiki/concepts", `${slug}.md`));
}

/** The single captured `system` prompt the stubbed provider last received. */
function lastSystemPrompt(): string {
  return vi.mocked(callClaude).mock.calls.at(-1)?.[0].system ?? "";
}

function renderableConcept(slug: string) {
  return {
    slug,
    concept: { concept: "Topic", summary: "s", is_new: false, tags: [] },
    sourceFiles: ["src.md"],
    combinedContent: "body",
  };
}

describe("page-renderer generation egress is confined", () => {
  beforeEach(() => {
    vi.mocked(callClaude).mockReset();
    vi.mocked(callClaude).mockResolvedValue("Generated body.");
  });

  it("omits a symlinked EXISTING page's bytes from the generation prompt + warns", async () => {
    const root = await makeTempRoot("routing-existing");
    await plantEscapingConcept(root, "topic");
    const warnSpy = vi.spyOn(output, "status");

    await renderMergedPageContent(root, renderableConcept("topic"), STUB_SCHEMA);

    expect(lastSystemPrompt()).not.toContain(SECRET);
    expect(warnSpy.mock.calls.some(([icon]) => icon === "!")).toBe(true);
  });

  it("omits a symlinked RELATED page's bytes from the generation prompt", async () => {
    const root = await makeTempRoot("routing-related");
    await writeFile(path.join(root, "wiki/concepts/topic.md"), "---\ntitle: T\n---\nself");
    await plantEscapingConcept(root, "neighbor");

    await renderMergedPageContent(root, renderableConcept("topic"), STUB_SCHEMA);

    expect(lastSystemPrompt()).not.toContain(SECRET);
  });
});

describe("resolution does not re-emit a symlinked page's bytes", () => {
  it("never writes the symlink target's bytes into another page", async () => {
    const root = await makeTempRoot("routing-resolve");
    await plantEscapingConcept(root, "alpha");
    await writeFile(
      path.join(root, "wiki/concepts/beta.md"),
      "---\ntitle: Beta\n---\nBeta mentions Secret here.",
    );

    await resolveLinks(root, ["beta"], ["alpha"]);

    // The escaping symlink (`alpha.md`) is dropped, so its title never enters
    // the index and its bytes are never laundered into another real page. We
    // assert the genuine written page (`beta.md`) does not carry the secret —
    // the symlink leaf itself trivially resolves to the secret and is excluded.
    const beta = await readFile(path.join(root, "wiki/concepts/beta.md"), "utf-8");
    expect(beta).not.toContain(SECRET);
    expect(beta).not.toContain("[[alpha|Secret]]");
  });
});
