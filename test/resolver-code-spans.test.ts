/**
 * @file test/resolver-code-spans.test.ts
 * @description Interlink resolution must never rewrite code.
 *
 * The resolver wraps every title mention in a `[[slug|Title]]` wikilink. Code
 * is copied verbatim by readers, so a title inside a fenced block or an inline
 * code span must stay untouched: before this guard a page about a tool named
 * "llmwiki" turned `.llmwiki/state.json` into `.[[llmwiki|llmwiki]]/state.json`
 * and put links inside shell examples. Prose mentions must still be linked.
 */

import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveAndApplyLinks } from "../src/compiler/resolver.js";
import { managedTempRoots } from "./fixtures/managed-temp-roots.js";

const roots = managedTempRoots();
afterEach(roots.cleanup);

const PAGE_FRONTMATTER = "---\ntitle: Remove Command\nsummary: s\nsources: []\n---\n\n";
const LINK = "[[llmwiki|llmwiki]]";

/** A project with an `llmwiki` target page, plus one page whose body is `body`; returns the rewritten body. */
async function resolveBody(body: string): Promise<string> {
  const root = await roots.create("resolver-code");
  await writeFile(path.join(root, "wiki/concepts/llmwiki.md"), "---\ntitle: llmwiki\nsummary: s\nsources: []\n---\n\nTarget.\n");
  const pagePath = path.join(root, "wiki/concepts/remove-command.md");
  await writeFile(pagePath, PAGE_FRONTMATTER + body);
  await resolveAndApplyLinks(root, ["remove-command"], []);
  return (await readFile(pagePath, "utf-8")).slice(PAGE_FRONTMATTER.length);
}

describe("interlink resolution leaves code untouched", () => {
  it("does not link inside a fenced code block, but links the prose around it", async () => {
    const body = "Run llmwiki first.\n\n```bash\nllmwiki rm notes.md\n```\n\nThen llmwiki again.\n";
    const after = await resolveBody(body);
    expect(after).toContain("```bash\nllmwiki rm notes.md\n```");
    expect(after).toBe(`Run ${LINK} first.\n\n\`\`\`bash\nllmwiki rm notes.md\n\`\`\`\n\nThen ${LINK} again.\n`);
  });

  it("does not link inside inline code such as a path", async () => {
    const after = await resolveBody("State lives in `.llmwiki/state.json` for llmwiki.\n");
    expect(after).toBe(`State lives in \`.llmwiki/state.json\` for ${LINK}.\n`);
  });

  it("handles tilde fences, double-backtick spans and an unclosed fence", async () => {
    const tilde = await resolveBody("~~~\nllmwiki compile\n~~~\n");
    expect(tilde).toBe("~~~\nllmwiki compile\n~~~\n");
    const doubled = await resolveBody("Use ``llmwiki `x` run`` here.\n");
    expect(doubled).toBe("Use ``llmwiki `x` run`` here.\n");
    const unclosed = await resolveBody("```\nllmwiki status\n");
    expect(unclosed).toBe("```\nllmwiki status\n");
  });

  // Markdown block structure: indented and container fences, indented code,
  // and a long fence wrapping a shorter example must all stay literal.
  it.each([
    ["an indented fence", "  ~~~sh\n  llmwiki status\n  ~~~"],
    ["a fence inside a blockquote", "> ~~~sh\n> llmwiki status\n> ~~~"],
    ["four-space indented code", "    llmwiki status"],
    ["a long fence around a shorter one", "````md\n```sh\nllmwiki status\n```\n````"],
    ["inline code that wraps a line", "Use `prefix\nllmwiki status` here."],
    ["an HTML pre block", "<pre>\nllmwiki status\n</pre>"],
    ["an HTML script block", "<script>\nconst llmwiki = 1;\n</script>"],
  ])("leaves %s untouched and still links the prose around it", async (_label, code) => {
    const after = await resolveBody(`See llmwiki.\n\n${code}\n\nThen llmwiki.\n`);
    expect(after).toBe(`See ${LINK}.\n\n${code}\n\nThen ${LINK}.\n`);
  });
});

describe("interlink resolution never writes a link where the renderer would not read one", () => {
  // Each place a title can appear but a link cannot. A link written there
  // broke a URL, destroyed a reference definition, or split a table cell.
  it.each([
    ["a Markdown link's URL", "See [the docs](https://example.com/llmwiki) here."],
    ["an autolink", "Visit <https://example.com/llmwiki/docs> now."],
    ["a Markdown link's text", "Read [about llmwiki](https://example.com) first."],
    ["an image's alt text", "![llmwiki logo](logo.png)"],
    ["a reference definition's URL", "Use [r].\n\n[r]: https://example.com/llmwiki"],
    ["a reference definition's label", "Use [llmwiki].\n\n[llmwiki]: https://example.com"],
    // Unused definitions render nothing, so only link recognition can see these.
    ["an unused reference definition's URL", "[r]: https://example.com/llmwiki"],
    ["an unused reference definition's title", "[r]: https://example.com \"About llmwiki\""],
    ["a table cell, where the link's pipe would split the cell", "| a | b |\n| - | - |\n| llmwiki | x |"],
  ])("leaves %s untouched and still links the prose around it", async (_label, markdown) => {
    const after = await resolveBody(`See llmwiki.\n\n${markdown}\n\nThen llmwiki.\n`);
    expect(after).toBe(`See ${LINK}.\n\n${markdown}\n\nThen ${LINK}.\n`);
  });

  it("links a title whose characters the renderer escapes", async () => {
    const root = await roots.create("resolver-escaped-title");
    const title = "Newton's Law & Co";
    await writeFile(path.join(root, "wiki/concepts/newtons-law.md"), `---\ntitle: "${title}"\nsummary: s\nsources: []\n---\n\nTarget.\n`);
    const pagePath = path.join(root, "wiki/concepts/remove-command.md");
    await writeFile(pagePath, `${PAGE_FRONTMATTER}Read about ${title} today.\n`);
    await resolveAndApplyLinks(root, ["remove-command"], []);
    expect(await readFile(pagePath, "utf-8")).toContain(`Read about [[newtons-law|${title}]] today.`);
  });

  it("still links prose that only looks like Markdown, including an apostrophe", async () => {
    const after = await resolveBody("An [unlinked] note on llmwiki's design & llmwiki <tags>.\n");
    expect(after).toBe(`An [unlinked] note on ${LINK}'s design & ${LINK} <tags>.\n`);
  });
});
