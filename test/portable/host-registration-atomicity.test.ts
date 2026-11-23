/**
 * @file test/portable/host-registration-atomicity.test.ts
 * @description Registration publication and interrupted-creation regressions.
 * Each test uses its own disposable root and host control state; no provider is used.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { assertUsableRegistration, LocalHostControl, registerLocalProject } from "../../src/portable/host/local-control.js";
import { projectRecordFile, rootMappingFile } from "../../src/portable/host/local-registry.js";
import { PORTABLE_DIR } from "../../src/portable/store/disk-layout.js";

let base = "";
let root = "";
let controlRoot = "";

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "llmwiki-register-atomic-"));
  root = path.join(base, "project");
  controlRoot = path.join(base, "control");
  await mkdir(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("registration publication", () => {
  it("serializes callers for one root around a single published identity", async () => {
    const results = await Promise.all([
      registerLocalProject(root, controlRoot),
      registerLocalProject(root, controlRoot),
      registerLocalProject(root, controlRoot),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.record.projectId)).size).toBe(1);
  });

  it("serializes separate CLI processes through the host control lock", async () => {
    const script = `
      const { registerLocalProject } = await import(process.cwd() + "/src/portable/host/local-control.ts");
      const result = await registerLocalProject(process.env.REGISTER_ROOT, process.env.REGISTER_CONTROL);
      console.log(JSON.stringify({ created: result.created, projectId: result.record.projectId }));
    `;
    const env = { ...process.env, REGISTER_ROOT: root, REGISTER_CONTROL: controlRoot };
    const children = Array.from({ length: 2 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", script], env, stdout: "pipe", stderr: "pipe",
    }));
    const results = await Promise.all(children.map(async (child) => ({
      exit: await child.exited,
      output: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    })));
    expect(results.map((result) => result.exit)).toEqual([0, 0]);
    const registrations = results.map((result) => JSON.parse(result.output));
    expect(registrations.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(registrations.map((result) => result.projectId)).size).toBe(1);
  });

  it("does not replace a root mapping claimed by another project", async () => {
    const first = await registerLocalProject(root, controlRoot);
    const mappingFile = rootMappingFile(controlRoot, root);
    const before = await readFile(mappingFile, "utf8");
    const control = await LocalHostControl.open(controlRoot);

    await expect(control.mapRoot(root, "prj_abcdef")).rejects.toThrow();
    expect(await readFile(mappingFile, "utf8")).toBe(before);
    expect((await control.projectForRoot(root))?.projectId).toBe(first.record.projectId);
  });

  it("finishes the ledger directory after a mapped registration was interrupted", async () => {
    const first = await registerLocalProject(root, controlRoot);
    const ledger = path.join(root, PORTABLE_DIR);
    await rm(ledger, { recursive: true });
    const control = await LocalHostControl.open(controlRoot);
    const pending = {
      ...first.record,
      requiredFeatures: [...first.record.requiredFeatures, "local-registration-in-progress"],
    };
    await control.saveProject(pending);
    expect(() => assertUsableRegistration(pending, control)).toThrow("newer portable format");

    const resumed = await registerLocalProject(root, controlRoot);
    expect([resumed.created, resumed.record.projectId]).toEqual([false, first.record.projectId]);
    expect((await stat(ledger)).isDirectory()).toBe(true);
    expect(resumed.record.requiredFeatures).not.toContain("local-registration-in-progress");
  });

  it("refuses a missing completed ledger instead of masking lost custody", async () => {
    const first = await registerLocalProject(root, controlRoot);
    const recordFile = projectRecordFile(controlRoot, first.record.projectId);
    const before = await readFile(recordFile, "utf8");
    await rm(path.join(root, PORTABLE_DIR), { recursive: true });
    await expect(registerLocalProject(root, controlRoot)).rejects.toThrow("preserve its custody");
    expect(await readFile(recordFile, "utf8")).toBe(before);
  });

  it("leaves an interrupted registration's existing ledger untouched", async () => {
    const first = await registerLocalProject(root, controlRoot);
    const control = await LocalHostControl.open(controlRoot);
    await control.saveProject({
      ...first.record,
      requiredFeatures: [...first.record.requiredFeatures, "local-registration-in-progress"],
    });
    const sentinel = path.join(root, PORTABLE_DIR, "custody-sentinel");
    await writeFile(sentinel, "retain this custody");

    await expect(registerLocalProject(root, controlRoot)).rejects.toThrow("refusing to adopt");
    expect(await readFile(sentinel, "utf8")).toBe("retain this custody");
  });

  it("refuses a pre-existing ledger without publishing a root mapping", async () => {
    await mkdir(path.join(root, PORTABLE_DIR), { recursive: true });
    await expect(registerLocalProject(root, controlRoot)).rejects.toThrow("another registration");
    const control = await LocalHostControl.open(controlRoot);
    expect(await control.projectForRoot(root)).toBeNull();
  });
});
