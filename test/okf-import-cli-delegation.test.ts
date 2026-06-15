// test/okf-import-cli-delegation.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import importCommand from "../src/commands/import.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { writeOneDocBundle } from "./fixtures/okf-bundle-fixture.js";

let dir: string;
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = undefined; if (dir) await rm(dir, { recursive: true, force: true }); });

describe("importCommand delegates to runOkfImport", () => {
  it("stages + prints a summary the CLI test relies on", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "icd-"));
    const b = await writeOneDocBundle(dir);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
    await importCommand(dir, { okf: b });
    expect(await listCandidates(dir)).toHaveLength(1);
    expect(out.join("\n")).toMatch(/staged 1 page/i);
  });
  it("prints exactly ONE friendly lock message when the lock is held", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "icd-lock-"));
    const b = await writeOneDocBundle(dir);
    await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
    await writeFile(path.join(dir, ".llmwiki", "lock"), String(process.pid), "utf-8");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => out.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a) => out.push(a.join(" ")));
    await importCommand(dir, { okf: b });
    const lockLines = out.filter((l) => /could not acquire lock/i.test(l));
    expect(lockLines).toHaveLength(1);
    expect(out.join("\n")).not.toMatch(/another compilation is running/i);
  });
});
