/**
 * @file test/template-publish-cli-e2e.test.ts
 * @description The publisher workflow through the REAL compiled CLI.
 *
 * This layer exists because unit tests call the functions directly and therefore cannot see
 * option-parsing faults. A `--version` flag on `publish add` was silently eaten by
 * Commander's global version flag: `add` never ran, and `build` happily published an EMPTY
 * distribution that still verified. Only a run through the built binary catches that.
 *
 * Every assertion rides ONE workflow run. Each CLI spawn is a full node start, and this
 * suite runs beside long subprocess e2e suites that sit near the 30s timeout — so the
 * coverage is kept and the process count is not.
 */
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PUBLISHER_TEMPLATE, publisherTempRoots } from "./fixtures/publisher-workspace.js";

const CLI = path.resolve("dist/cli.js");
const roots = publisherTempRoots();
afterEach(roots.cleanup);

function run(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

describe("publisher CLI end to end", () => {
  it("initializes, adds, builds, verifies, and never publishes a private key", async () => {
    const root = await roots.create("cli-pub");
    const workspace = path.join(root, "w");
    const out = path.join(root, "dist");
    const packageFile = path.join(root, "package.json");
    await writeFile(packageFile, JSON.stringify(PUBLISHER_TEMPLATE), "utf8");

    const init = run(["template", "publish", "init", workspace, "--tap", "community", "--publisher", "acme"]);
    expect(init.status).toBe(0);

    const add = run([
      "template", "publish", "add", packageFile,
      "--workspace", workspace, "--package-version", "1.0.0",
    ]);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain("Recorded signed package");
    expect(add.stdout).toContain("community/acme/incident-response@1.0.0");

    const build = run([
      "template", "publish", "build",
      "--workspace", workspace, "--expires-in", "30d", "--out", out,
    ]);
    expect(build.status).toBe(0);
    // The regression that mattered: an eaten --version silently produced ZERO packages and
    // still built a "valid" empty distribution.
    expect(build.stdout).toContain("Packages: 1");

    const keysDir = path.join(workspace, "keys");
    const keys = await readdir(keysDir);
    const tapKeyId = keys.find((f) => f.startsWith("tap-") && f.endsWith(".pub"))!
      .replace(/^tap-/, "").replace(/\.pub$/, "");

    const verify = run([
      "template", "publish", "verify", out,
      "--tap", "community", "--key-id", tapKeyId,
      "--key-file", path.join(keysDir, `tap-${tapKeyId}.pub`),
    ]);
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain("Verified template publisher distribution");
    expect(verify.stdout).toContain("Packages: 1");

    // No private key byte may reach the published tree.
    const privateKeys = await Promise.all(
      keys.filter((f) => f.endsWith(".key"))
        .map(async (f) => (await readFile(path.join(keysDir, f), "utf8")).trim()),
    );
    const digestDir = path.join(out, "packages", "sha256");
    const published = await Promise.all([
      readFile(path.join(out, "index.json"), "utf8"),
      ...(await readdir(digestDir)).map((f) => readFile(path.join(digestDir, f), "utf8")),
    ]);
    expect(privateKeys.length).toBeGreaterThan(0);
    for (const key of privateKeys) {
      for (const blob of published) expect(blob).not.toContain(key);
    }

    // And the output may never live inside the workspace, which would publish those keys.
    const inside = run([
      "template", "publish", "build",
      "--workspace", workspace, "--expires-in", "30d",
      "--out", path.join(workspace, "dist"),
    ]);
    expect(inside.status).not.toBe(0);
    expect(`${inside.stdout}${inside.stderr}`).toMatch(/outside the publisher workspace/i);
  });
});
