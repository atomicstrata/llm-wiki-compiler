/**
 * @file test/preparations/lifecycle-namespace.test.ts
 * @description Root and registry authority for preparation lifecycle state.
 *
 * These tests pin the Task 9B boundary: `.llmwiki` and both lifecycle
 * registries are captured beneath one canonical project root, absence remains
 * distinct from unavailability, read mode is pure, and later identity changes
 * invalidate the namespace.
 */

import { lstat, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempRoot, useTempRoot } from "../fixtures/temp-root.js";
import {
  assertPreparationLifecycleNamespaceCurrent,
  openPreparationLifecycleNamespace,
  PreparationLifecycleNamespaceError,
} from "../../src/preparations/lifecycle-fs/namespace.js";
import {
  lifecyclePruneUnitPaths,
  lifecyclePreparationKeyFile,
  lifecycleQuarantineUnitPaths,
} from "../../src/preparations/lifecycle-fs/paths.js";
import type { PreparationLifecycleNamespaceV1 } from "../../src/preparations/lifecycle-fs/types.js";

const PRIVATE_SEGMENT = ".llmwiki";
const QUARANTINE_SEGMENT = "preparation-quarantine";
const PRUNE_SEGMENT = "preparation-prune";
const KEY_FILENAME = "preparation-runs.runkey";

/** Locate one lifecycle-owned directory beneath a project root. */
function lifecyclePath(root: string, ...segments: string[]): string {
  return path.join(root, PRIVATE_SEGMENT, ...segments);
}

describe("preparation lifecycle namespace read mode", () => {
  const root = useTempRoot();

  it("reports a proven-absent private root without creating it", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "read");
    expect(namespace.privateRoot.status).toBe("absent");
    expect(namespace.quarantineRegistry.status).toBe("absent");
    expect(namespace.pruneRegistry.status).toBe("absent");
    await expect(lstat(lifecyclePath(root.dir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an in-project .llmwiki decoy symlink", async () => {
    const decoy = path.join(root.dir, "decoy");
    await mkdir(decoy);
    await symlink(decoy, lifecyclePath(root.dir));
    await expect(openPreparationLifecycleNamespace(root.dir, "read"))
      .rejects.toMatchObject({ code: "private-root-unavailable" });
  });

  it("rejects an out-of-project .llmwiki decoy symlink", async () => {
    const outside = await makeTempRoot("lifecycle-outside");
    try {
      await symlink(outside, lifecyclePath(root.dir));
      await expect(openPreparationLifecycleNamespace(root.dir, "read"))
        .rejects.toMatchObject({ code: "private-root-unavailable" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts a project-root alias while binding its canonical target", async () => {
    const alias = `${root.dir}-alias`;
    await symlink(root.dir, alias);
    try {
      const direct = await openPreparationLifecycleNamespace(root.dir, "read");
      const aliased = await openPreparationLifecycleNamespace(alias, "read");
      expect(aliased.root.realPath).toBe(await realpath(root.dir));
      expect(aliased.digest).toBe(direct.digest);
      await expect(assertPreparationLifecycleNamespaceCurrent(aliased)).resolves.toBeUndefined();
    } finally {
      await rm(alias);
    }
  });

  it("rejects a redirected registry beneath a real private root", async () => {
    await mkdir(lifecyclePath(root.dir), { recursive: true });
    const decoy = path.join(root.dir, "registry-decoy");
    await mkdir(decoy);
    await symlink(decoy, lifecyclePath(root.dir, QUARANTINE_SEGMENT));
    await expect(openPreparationLifecycleNamespace(root.dir, "read"))
      .rejects.toMatchObject({ code: "registry-unavailable" });
  });

  it("rejects a non-directory registry instead of treating it as absent", async () => {
    await mkdir(lifecyclePath(root.dir), { recursive: true });
    await writeFile(lifecyclePath(root.dir, QUARANTINE_SEGMENT), "not-a-directory");
    await expect(openPreparationLifecycleNamespace(root.dir, "read"))
      .rejects.toMatchObject({ code: "registry-unavailable" });
  });
});

describe("preparation lifecycle namespace mutation mode", () => {
  const root = useTempRoot();

  it("creates and binds the owned namespace and both registries", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "mutate");
    expect(namespace.privateRoot.status).toBe("present");
    expect(namespace.quarantineRegistry.status).toBe("present");
    expect(namespace.pruneRegistry.status).toBe("present");
    expect((await lstat(lifecyclePath(root.dir, QUARANTINE_SEGMENT))).isDirectory()).toBe(true);
    expect((await lstat(lifecyclePath(root.dir, PRUNE_SEGMENT))).isDirectory()).toBe(true);
  });

  it("invalidates a registry replaced after capture", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "mutate");
    const registry = lifecyclePath(root.dir, QUARANTINE_SEGMENT);
    await rename(registry, `${registry}-old`);
    await mkdir(registry);
    await expect(assertPreparationLifecycleNamespaceCurrent(namespace))
      .rejects.toMatchObject({ code: "namespace-changed" });
  });

  it("revalidates identities before returning an opened namespace", async () => {
    const registry = lifecyclePath(root.dir, QUARANTINE_SEGMENT);
    await expect(openPreparationLifecycleNamespace(root.dir, "mutate", {
      beforeFinalRevalidationForTest: async () => {
        await rename(registry, `${registry}-old`);
        await mkdir(registry);
      },
    })).rejects.toMatchObject({ code: "namespace-changed" });
  });

  it("binds the derived key leaf and rejects its replacement before return", async () => {
    const keyFile = lifecyclePath(root.dir, KEY_FILENAME);
    await mkdir(lifecyclePath(root.dir));
    await writeFile(keyFile, "first", { mode: 0o600 });
    await expect(openPreparationLifecycleNamespace(root.dir, "mutate", {
      beforeFinalRevalidationForTest: async () => {
        await rename(keyFile, `${keyFile}-old`);
        await writeFile(keyFile, "second", { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: "namespace-changed" });
  });

  it("validates both registries before creating either missing sibling", async () => {
    await mkdir(lifecyclePath(root.dir));
    const decoy = path.join(root.dir, "prune-decoy");
    await mkdir(decoy);
    await symlink(decoy, lifecyclePath(root.dir, PRUNE_SEGMENT));
    await expect(openPreparationLifecycleNamespace(root.dir, "mutate"))
      .rejects.toMatchObject({ code: "registry-unavailable" });
    await expect(lstat(lifecyclePath(root.dir, QUARANTINE_SEGMENT)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates a directory captured absent when it later appears", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "read");
    await mkdir(lifecyclePath(root.dir));
    await expect(assertPreparationLifecycleNamespaceCurrent(namespace))
      .rejects.toBeInstanceOf(PreparationLifecycleNamespaceError);
  });

  it("freezes authority data and derives unit paths without a caller root", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "mutate");
    expect(Object.isFrozen(namespace)).toBe(true);
    expect(Object.isFrozen(namespace.root)).toBe(true);
    expect(Object.isFrozen(namespace.quarantineRegistry)).toBe(true);
    expect(Object.isFrozen(namespace.preparationKey)).toBe(true);
    expect(lifecyclePreparationKeyFile(namespace))
      .toBe(lifecyclePath(namespace.root.realPath, KEY_FILENAME));
    expect(lifecycleQuarantineUnitPaths(namespace, "qtn-unit").unitRoot)
      .toBe(lifecyclePath(namespace.root.realPath, QUARANTINE_SEGMENT, "qtn-unit"));
    expect(lifecyclePruneUnitPaths(namespace, "prn-unit").unitRoot)
      .toBe(lifecyclePath(namespace.root.realPath, PRUNE_SEGMENT, "prn-unit"));
  });

  it("rejects a structurally forged namespace at path derivation", async () => {
    const namespace = await openPreparationLifecycleNamespace(root.dir, "mutate");
    const forged = Object.freeze({ ...namespace }) as PreparationLifecycleNamespaceV1;
    expect(() => lifecycleQuarantineUnitPaths(forged, "qtn-unit"))
      .toThrow("namespace was not opened by the lifecycle authority");
  });

  it("keeps key bytes out of the immutable namespace and its digest", async () => {
    const keyBody = "c2VjcmV0LWJ5dGVzLXRoYXQtbXVzdC1ub3QtbGVhaw==";
    await mkdir(lifecyclePath(root.dir));
    await writeFile(lifecyclePath(root.dir, KEY_FILENAME), keyBody, { mode: 0o600 });
    const namespace = await openPreparationLifecycleNamespace(root.dir, "mutate");
    expect(JSON.stringify(namespace)).not.toContain(keyBody);
    expect(namespace.digest).not.toContain(keyBody);
  });
});
