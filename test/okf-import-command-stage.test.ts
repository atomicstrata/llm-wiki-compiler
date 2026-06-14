import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile, stat } from "fs/promises";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { useOkfTempDir } from "./fixtures/okf-temp-dir.js";

const { make } = useOkfTempDir();
afterEach(() => { process.exitCode = 0; });

/** Build a single-concept bundle dir and return its path. */
async function conceptBundle(dir: string, body: string): Promise<string> {
  const b = path.join(dir, "kb");
  await mkdir(path.join(b, "concepts"), { recursive: true });
  await writeFile(path.join(b, "concepts", "a.md"), body);
  return b;
}

describe("import (default = stage candidates)", () => {
  it("stages each doc as an imported candidate and leaves wiki/ untouched", async () => {
    const dir = await make("okf-cmd-");
    const b = await conceptBundle(dir, "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    await importCommand(dir, { okf: b });
    const cands = await listCandidates(dir);
    expect(cands).toHaveLength(1);
    expect(cands[0].reviewMode).toBe("imported");
    expect(cands[0].heldReasons[0].code).toBe("imported-okf");
    expect(cands[0].targetDirectory).toBe("concepts");
    expect(cands[0].slug).toBe("a"); // concepts/ prefix stripped
    await expect(stat(path.join(dir, "wiki/concepts/a.md"))).rejects.toThrow();
  });

  it("does not stage anything when the lock is held by a live process", async () => {
    const dir = await make("okf-lock-");
    const b = await conceptBundle(dir, "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
    await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
    await writeFile(path.join(dir, ".llmwiki/lock"), String(process.pid));
    await importCommand(dir, { okf: b });
    expect(await listCandidates(dir)).toHaveLength(0);
  });

  it("skips an empty-body doc so nothing unapprovable enters the queue", async () => {
    const dir = await make("okf-empty-");
    const b = await conceptBundle(dir, "---\ntype: concept\ntitle: A\n---\n\n");
    await importCommand(dir, { okf: b });
    expect(await listCandidates(dir)).toHaveLength(0);
  });
});
