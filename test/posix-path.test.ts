/**
 * @file test/posix-path.test.ts
 * @description Pins `toPosixPath` and the index-link construction it guards
 * (#163, output-side instance).
 *
 * `path.relative` emits the PLATFORM separator. That is correct while the result
 * is a filesystem argument and wrong the moment it becomes portable CONTENT — a
 * markdown link, a stored id. `src/compiler/indexgen.ts` builds an entity-page
 * link from `path.relative(WIKI_ROOT, page.directory)`, so on win32 a NESTED
 * entity directory (`wiki/research/papers`) produced `research\papers/foo.md`:
 * a broken link in every generated index.
 *
 * These assertions run the win32 case explicitly (via `path.win32` and the
 * separator seam) so the behaviour is verified from a POSIX runner too — the
 * Linux-only CI that let #163 ship in the first place is exactly why this must
 * not depend on the platform the suite happens to run on.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { toPosixPath } from "../src/utils/path-confine.js";

const WIN_SEP = "\\";

describe("toPosixPath", () => {
  it("rewrites win32 separators to POSIX", () => {
    expect(toPosixPath("research\\papers", WIN_SEP)).toBe("research/papers");
    expect(toPosixPath("a\\b\\c", WIN_SEP)).toBe("a/b/c");
  });

  it("leaves an already-POSIX path untouched", () => {
    expect(toPosixPath("research/papers", "/")).toBe("research/papers");
    expect(toPosixPath("papers", WIN_SEP)).toBe("papers");
    expect(toPosixPath("", WIN_SEP)).toBe("");
  });

  it("never rewrites a backslash that is part of a POSIX file name", () => {
    // On POSIX `\` is a legal filename character; splitting on `[\\/]` here
    // would corrupt a real directory named `odd\name`.
    expect(toPosixPath("odd\\name", "/")).toBe("odd\\name");
  });

  it("is identity on the running platform's own separator", () => {
    expect(toPosixPath(path.join("a", "b"))).toBe("a/b");
  });
});

describe("entity-page index links stay POSIX on every platform (#163)", () => {
  /** The exact expression `buildEntitySections` uses to build a link target. */
  const link = (relative: string, slug: string) => `${toPosixPath(relative, WIN_SEP)}/${slug}.md`;

  it("keeps a nested entity directory's link slash-separated under win32", () => {
    const relative = path.win32.relative("wiki", "wiki/research/papers");
    expect(relative).toBe("research\\papers"); // what path.relative hands us on win32
    expect(link(relative, "foo")).toBe("research/papers/foo.md");
    expect(link(relative, "foo")).not.toContain(WIN_SEP);
  });

  it("is unchanged for a single-level directory, which is why this went unnoticed", () => {
    const relative = path.win32.relative("wiki", "wiki/papers");
    expect(relative).toBe("papers");
    expect(link(relative, "foo")).toBe("papers/foo.md");
  });
});
