/**
 * @file test/profile-template-tap-cli.test.ts
 * @description Compiled CLI proof for tap lifecycle and read-only discovery.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addTap } from "../src/profile/templates/taps/manage.js";
import { resolveRemotePackage } from "../src/profile/templates/taps/package.js";
import { resolveTapPaths } from "../src/profile/templates/taps/paths.js";
import { refreshTap } from "../src/profile/templates/taps/refresh.js";
import { servesTemplateBytes, templateRegistryFixture, TAP_KEY } from "./fixtures/template-tap-runtime.js";

const CLI = path.resolve("dist/cli.js");
const COORDINATE = "official/atomicstrata/team@1.0.0";
const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "llmwiki-tap-cli-"));
  roots.push(value);
  return value;
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: path.join(cwd, "operator-config"), XDG_CACHE_HOME: path.join(cwd, "operator-cache") },
  });
}

function paths(cwd: string) {
  return resolveTapPaths({
    configRoot: path.join(cwd, "operator-config", "llmwiki"),
    cacheRoot: path.join(cwd, "operator-cache", "llmwiki", "templates"),
  });
}

async function seed(cwd: string): Promise<void> {
  const store = paths(cwd);
  await addTap(store, { name: "official", indexUrl: "https://tap.example/index.json", key: TAP_KEY });
  await refreshTap(store, "official", servesTemplateBytes(await templateRegistryFixture("index.json")));
  await resolveRemotePackage(store, COORDINATE, { seams: servesTemplateBytes(await templateRegistryFixture("package.json")) });
}

afterEach(async () => Promise.all(roots.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("template tap CLI", () => {
  it("adds, lists, and disables a tap without writing project state", async () => {
    const cwd = await root();
    const add = run(cwd, ["template", "tap", "add", "community", "https://tap.example/index.json", "--key-id", TAP_KEY.keyId, "--key-base64", TAP_KEY.publicKey]);
    expect(add.status).toBe(0);
    const list = run(cwd, ["template", "tap", "list", "--json"]);
    expect(JSON.parse(list.stdout)).toMatchObject([{ name: "community", enabled: true }]);
    expect(list.stdout).not.toContain(TAP_KEY.publicKey);
    expect(run(cwd, ["template", "tap", "remove", "community"]).status).toBe(0);
    expect(run(cwd, ["template", "tap", "forget", "community"]).status).toBe(1);
    expect(run(cwd, ["template", "tap", "forget", "community", "--yes"]).status).toBe(0);
    await expect(stat(path.join(cwd, ".llmwiki"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("searches, inspects, and verifies cached signed evidence", async () => {
    const cwd = await root();
    await seed(cwd);
    const search = run(cwd, ["template", "search", "team", "--json"]);
    const inspect = run(cwd, ["template", "inspect", "official/atomicstrata/team@1.0.0", "--json"]);
    const verify = run(cwd, ["template", "verify", "official/atomicstrata/team@1.0.0", "--json"]);
    expect(JSON.parse(search.stdout).results[0]).toMatchObject({ templateId: "team" });
    expect(JSON.parse(inspect.stdout)).toMatchObject({ displayName: "Team", templateId: "team" });
    expect(JSON.parse(verify.stdout)).toMatchObject({ verified: true, publisherKeyId: "publisher-key-1" });
    await expect(stat(path.join(cwd, ".llmwiki"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses non-interactive remote install without --yes", async () => {
    const cwd = await root();
    await seed(cwd);
    const result = run(cwd, ["template", "init", COORDINATE]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("confirmation or --yes");
    await expect(stat(path.join(cwd, ".llmwiki"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs verified remote evidence with --yes", async () => {
    const cwd = await root();
    await seed(cwd);
    const result = run(cwd, ["template", "init", COORDINATE, "--yes", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "installed",
      coordinate: COORDINATE,
      publisherKeyId: "publisher-key-1",
      tapSequence: 1,
      capabilities: { entities: 1 },
    });
    expect(result.stdout).not.toContain("publicKey");
    expect(result.stdout).not.toContain("publisherSignature");
    const lock = JSON.parse(await readFile(path.join(cwd, ".llmwiki/template-lock.json"), "utf8"));
    expect(lock).toMatchObject({ sourceType: "remote", remote: { coordinate: COORDINATE } });
  });
});
