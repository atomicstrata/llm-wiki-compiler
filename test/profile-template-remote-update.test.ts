/**
 * @file test/profile-template-remote-update.test.ts
 * @description Remote update planning and execution are exact-release,
 * fail-closed, and fully revalidated under the project and tap-state locks.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTemplateStatus } from "../src/profile/templates/status.js";
import { planRemoteTemplateUpdate } from "../src/profile/templates/remote-lifecycle.js";
import { applyRemoteTemplateUpdate } from "../src/profile/templates/update-apply.js";
import {
  buildTemplateLock,
  writeAdvisoryTemplateLock,
} from "../src/profile/templates/install.js";
import { remoteProvenanceForResolved } from "../src/profile/templates/remote-lifecycle.js";
import { removeTap } from "../src/profile/templates/taps/manage.js";
import { TEMPLATE_LOCK_FILE } from "../src/profile/templates/lock.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import { journalHealth } from "../src/trust/journal-health.js";
import { openBatch, recordPreState } from "../src/trust/journal.js";
import {
  remoteUpdateFixture,
  removeRemoteUpdateRoots,
  TARGET_COORDINATE,
} from "./fixtures/template-remote-update.js";

const roots: string[] = [];
const CLI = path.resolve("dist/cli.js");

afterEach(async () => removeRemoteUpdateRoots(roots));

describe("remote template update", () => {
  it("plans a compatible exact-release update without writing", async () => {
    const fixture = await remoteUpdateFixture(roots);
    const before = await readFile(path.join(fixture.project, ".llmwiki/profile.json"), "utf8");
    const plan = await planRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0");
    expect(plan).toMatchObject({
      authority: "advisory",
      compatible: true,
      toCoordinate: TARGET_COORDINATE,
      reasons: [],
    });
    expect(await readFile(path.join(fixture.project, ".llmwiki/profile.json"), "utf8")).toBe(before);
    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({
      updateAvailable: TARGET_COORDINATE,
    });
  });

  it("applies a compatible update and advances verified provenance", async () => {
    const fixture = await remoteUpdateFixture(roots);
    const result = await applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0");
    const profile = JSON.parse(await readFile(path.join(fixture.project, ".llmwiki/profile.json"), "utf8"));
    const lock = JSON.parse(await readFile(path.join(fixture.project, ".llmwiki/template-lock.json"), "utf8"));
    expect(result).toMatchObject({ kind: "updated", toCoordinate: TARGET_COORDINATE });
    expect(profile).toMatchObject({ profileId: "team", profileVersion: "1.1.0" });
    expect(lock).toMatchObject({ version: "1.1.0", remote: { coordinate: TARGET_COORDINATE } });
    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({ status: "installed-clean" });
  });

  it("catches profile drift introduced after prefetch and writes nothing further", async () => {
    const fixture = await remoteUpdateFixture(roots);
    const profilePath = path.join(fixture.project, ".llmwiki/profile.json");
    await expect(applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0", {
      afterPrefetchForTest: async () => {
        const profile = JSON.parse(await readFile(profilePath, "utf8"));
        await writeFile(profilePath, JSON.stringify({ ...profile, displayName: "Local edit" }), "utf8");
      },
    })).rejects.toThrow(/incompatible/);
    expect(JSON.parse(await readFile(profilePath, "utf8"))).toMatchObject({ displayName: "Local edit" });
  });

  it("refuses when tap authority changes after prefetch", async () => {
    const fixture = await remoteUpdateFixture(roots);
    await expect(applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0", {
      afterPrefetchForTest: async () => removeTap(fixture.paths, "official"),
    })).rejects.toThrow(/unavailable or disabled/);
    await expect(readLockVersion(fixture.project)).resolves.toBe("1.0.0");
  });

  it("rolls back provenance when profile writing fails", async () => {
    const fixture = await remoteUpdateFixture(roots);
    await expect(applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0", {
      writeProfileForTest: async () => { throw new Error("injected profile write failure"); },
    })).rejects.toThrow(/injected/);
    await expect(readLockVersion(fixture.project)).resolves.toBe("1.0.0");
    await expectHealthyTemplateState(fixture);
  });

  it("surfaces and recovers an interrupted two-file update before retry", async () => {
    const fixture = await remoteUpdateFixture(roots);
    const batch = await openBatch(fixture.project);
    await recordPreState(batch, path.join(fixture.project, TEMPLATE_LOCK_FILE));
    await recordPreState(batch, path.join(fixture.project, PROFILE_FILE));
    await writeAdvisoryTemplateLock(fixture.project, buildTemplateLock(fixture.target.package, {
      sourceType: "remote",
      remote: remoteProvenanceForResolved(fixture.target),
    }));

    await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({
      status: "interrupted-write",
    });
    await expect(applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0"))
      .resolves.toMatchObject({ kind: "updated", toCoordinate: TARGET_COORDINATE });
    await expectHealthyTemplateState(fixture);
  });

  it("revalidates pending candidates under lock before writing", async () => {
    const fixture = await remoteUpdateFixture(roots);
    await mkdir(path.join(fixture.project, ".llmwiki/candidates"), { recursive: true });
    await writeFile(path.join(fixture.project, ".llmwiki/candidates/pending.json"), "{}", "utf8");
    await expect(applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0"))
      .rejects.toThrow(/pending review candidates/);
    await expect(readLockVersion(fixture.project)).resolves.toBe("1.0.0");
  });

  it("refuses non-interactive CLI update without --yes", async () => {
    const fixture = await remoteUpdateFixture(roots);
    const result = runCli(fixture.project, fixture.paths, ["template", "update", "--to", "1.1.0"]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("confirmation or --yes");
    await expect(readLockVersion(fixture.project)).resolves.toBe("1.0.0");
  });

  it("previews and applies through the compiled CLI", async () => {
    const fixture = await remoteUpdateFixture(roots);
    const preview = runCli(fixture.project, fixture.paths, ["template", "update", "--to", "1.1.0", "--dry-run", "--json"]);
    expect(preview.status).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ authority: "advisory", toCoordinate: TARGET_COORDINATE });
    const apply = runCli(fixture.project, fixture.paths, ["template", "update", "--to", "1.1.0", "--yes", "--json"]);
    expect(apply.status).toBe(0);
    expect(JSON.parse(apply.stdout)).toMatchObject({ kind: "updated", toCoordinate: TARGET_COORDINATE });
  });
});

function runCli(root: string, paths: { configRoot: string; cacheRoot: string }, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.dirname(paths.configRoot),
      XDG_CACHE_HOME: path.dirname(path.dirname(paths.cacheRoot)),
    },
  });
}

async function readLockVersion(root: string): Promise<string> {
  const text = await readFile(path.join(root, ".llmwiki/template-lock.json"), "utf8");
  return JSON.parse(text).version;
}

async function expectHealthyTemplateState(
  fixture: Awaited<ReturnType<typeof remoteUpdateFixture>>,
): Promise<void> {
  await expect(collectTemplateStatus(fixture.project, fixture.paths)).resolves.toMatchObject({ status: "installed-clean" });
  await expect(journalHealth(fixture.project)).resolves.toEqual({ status: "ok" });
}
