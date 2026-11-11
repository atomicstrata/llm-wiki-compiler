/**
 * @file test/storage/schema-init-writes.test.ts
 * @description `schema init` through its REAL command function after its three
 * disk calls moved behind `src/storage/`. One narrow recorder notes the
 * existence check, the directory creation and the write (under both the bare
 * and the `node:` module names), with their arguments, and can make the write
 * fail. Files are real; the working directory is a temp project.
 *
 * The two built-CLI cases in `test/schema-integration.test.ts` already show
 * that a schema is written and that an existing one is kept. These cases pin
 * only what those do not state: the exact bytes, the order and arguments of
 * the three calls, that NOTHING is called after a positive existence check,
 * what a directory and a dangling link at the target do, that a failing write
 * rejects raw, and that only `schema.json` is checked.
 *
 * The dangling-link case records INCUMBENT behaviour, kept on purpose and not
 * endorsed: the check follows links, so the write goes through the link.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

/** `calls` are "<operation> <last path segment> <argument>"; `failWrite` is raised by the write when set. */
const io = { on: false, calls: [] as string[], failWrite: null as Error | null };

const recorder = (() => {
  const leaf = (file: unknown): string => String(file).slice(String(file).lastIndexOf("/") + 1);
  const note = (operation: string, file: unknown, detail: unknown): void => {
    if (io.on) io.calls.push(`${operation} ${leaf(file)} ${JSON.stringify(detail)}`);
  };
  /** Wrap the synchronous existence check of one `fs` module object. */
  const sync = <T extends { existsSync: (file: string) => boolean }>(actual: T) => {
    const existsSync = (file: string): boolean => { note("existsSync", file, null); return actual.existsSync(file); };
    return { ...actual, existsSync, default: { ...actual, existsSync } };
  };
  type Promises = { mkdir: (...args: never[]) => Promise<unknown>; writeFile: (...args: never[]) => Promise<void> };
  /** Wrap the directory creation and the write of one `fs/promises` module object. */
  const asynchronous = <T extends Promises>(actual: T) => {
    const mkdir = (...args: unknown[]): Promise<unknown> => { note("mkdir", args[0], args[1]); return (actual.mkdir as (...rest: unknown[]) => Promise<unknown>)(...args); };
    const writeFile = (...args: unknown[]): Promise<void> => {
      note("writeFile", args[0], args[2]);
      if (io.on && io.failWrite) return Promise.reject(io.failWrite);
      return (actual.writeFile as (...rest: unknown[]) => Promise<void>)(...args);
    };
    return { ...actual, mkdir, writeFile, default: { ...actual, mkdir, writeFile } };
  };
  return { sync, asynchronous };
})();

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFsPromises = { ...(await import("node:fs/promises")) };
const realFs = { ...(await import("fs")) };


vi.mock("fs", () => recorder.sync(realFs));
vi.mock("node:fs", () => recorder.sync(realFs));
vi.mock("fs/promises", () => recorder.asynchronous(realFsPromises));
vi.mock("node:fs/promises", () => recorder.asynchronous(realFsPromises));

import { schemaInitCommand } from "../../src/commands/schema.js";
import { buildDefaultSchema } from "../../src/schema/index.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const fs = realFsPromises;
const CALLS = ["existsSync schema.json null", 'mkdir .llmwiki {"recursive":true}', 'writeFile schema.json "utf-8"'];
useTempRoot();
let printed: string[] = [];
const target = (): string => path.join(process.cwd(), ".llmwiki", "schema.json");

/** Run the command with recording on, capturing what it prints. */
async function runInit(): Promise<void> {
  io.on = true;
  try {
    await schemaInitCommand();
  } finally {
    io.on = false;
  }
}

beforeEach(() => {
  Object.assign(io, { on: false, calls: [], failWrite: null });
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { printed.push(parts.join(" ")); });
});
afterEach(() => { io.on = false; });

describe("schema init on an ordinary project", () => {
  it("writes exactly the starter schema, after one check and one directory step", async () => {
    await runInit();
    const text = await fs.readFile(target(), "utf-8");
    const defaults = buildDefaultSchema();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["version", "defaultKind", "kinds", "seedPages"]);
    expect(parsed).toEqual({ version: defaults.version, defaultKind: defaults.defaultKind, kinds: defaults.kinds, seedPages: defaults.seedPages });
    expect(text).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(io.calls).toEqual(CALLS);
    expect(printed.join("\n")).toContain(`Wrote schema to ${target()}`);
  });

  it("makes no directory and writes nothing when the schema file is already there", async () => {
    await fs.mkdir(path.dirname(target()), { recursive: true });
    await fs.writeFile(target(), "mine\n");
    await runInit();
    expect(io.calls).toEqual(CALLS.slice(0, 1));
    expect(await fs.readFile(target(), "utf-8")).toBe("mine\n");
    expect(printed.join("\n")).toContain(`Schema file already exists at ${target()}`);
  });

  it("treats a directory at the schema path as existing", async () => {
    await fs.mkdir(target(), { recursive: true });
    await runInit();
    expect(io.calls).toEqual(CALLS.slice(0, 1));
    expect((await fs.lstat(target())).isDirectory()).toBe(true);
  });

  it("writes THROUGH a dangling link at the schema path (incumbent behaviour, kept)", async () => {
    await fs.mkdir(path.dirname(target()), { recursive: true });
    await fs.symlink("../elsewhere.json", target());
    await runInit();
    expect(io.calls).toEqual(CALLS);
    expect((await fs.lstat(target())).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(process.cwd(), "elsewhere.json"), "utf-8"))).toHaveProperty("kinds");
  });

  it("rejects with the raw error of a failing write and prints no success line", async () => {
    io.failWrite = Object.assign(new Error("write sabotaged"), { code: "EIO" });
    await expect(runInit()).rejects.toBe(io.failWrite);
    expect(io.calls).toEqual(CALLS);
    expect(printed.join("\n")).not.toContain("Wrote schema");
  });

  it("still writes schema.json when only a YAML schema is present", async () => {
    await fs.mkdir(path.dirname(target()), { recursive: true });
    await fs.writeFile(path.join(path.dirname(target()), "schema.yaml"), "version: 1\n");
    await runInit();
    expect(io.calls).toEqual(CALLS);
    expect(JSON.parse(await fs.readFile(target(), "utf-8"))).toHaveProperty("defaultKind");
  });
});
