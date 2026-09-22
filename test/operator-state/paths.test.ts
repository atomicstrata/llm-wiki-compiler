/**
 * @file test/operator-state/paths.test.ts
 * @description Cross-platform unverified-root computation and legacy TAP
 * path/private-leaf compatibility coverage. These tests do not authorize a
 * provider store or certify ancestor ownership and confinement.
 */
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveLlmwikiOperatorRoots,
  type LlmwikiOperatorRootInputs,
} from "../../src/operator-state/paths.js";
import { ensurePrivateRoot } from "../../src/operator-state/private-root.js";
import { resolveTapPaths } from "../../src/profile/templates/taps/paths.js";
import { ensurePrivateRoot as ensureTapPrivateRoot } from "../../src/profile/templates/taps/private-root.js";
import { resolveLegacyTapPaths } from "../fixtures/legacy-tap-paths-baseline.js";

const ROOT_CASES = [
  {
    name: "Linux defaults",
    inputs: { env: {}, home: "/home/ada", platform: "linux" as const },
    expected: unverified("/home/ada/.config/llmwiki", "/home/ada/.cache/llmwiki"),
  },
  {
    name: "macOS defaults",
    inputs: { env: {}, home: "/Users/ada", platform: "darwin" as const },
    expected: unverified("/Users/ada/.config/llmwiki", "/Users/ada/.cache/llmwiki"),
  },
  {
    name: "Windows application data",
    inputs: {
      env: windowsEnv("C:\\Users\\Ada\\AppData\\Roaming", "C:\\Users\\Ada\\AppData\\Local"),
      home: "C:\\Users\\Ada",
      platform: "win32" as const,
    },
    expected: unverified(
      "C:\\Users\\Ada\\AppData\\Roaming\\llmwiki",
      "C:\\Users\\Ada\\AppData\\Local\\llmwiki\\cache",
    ),
  },
  {
    name: "absolute XDG roots",
    inputs: {
      env: { XDG_CONFIG_HOME: "/operator/config", XDG_CACHE_HOME: "/operator/cache" },
      home: "/home/ada",
      platform: "linux" as const,
    },
    expected: unverified("/operator/config/llmwiki", "/operator/cache/llmwiki"),
  },
  {
    name: "relative XDG roots are ignored",
    inputs: {
      env: { XDG_CONFIG_HOME: ".config", XDG_CACHE_HOME: ".cache" },
      home: "/home/ada",
      platform: "linux" as const,
    },
    expected: unverified("/home/ada/.config/llmwiki", "/home/ada/.cache/llmwiki"),
  },
  {
    name: "explicit computation overrides",
    inputs: {
      env: {},
      home: "/ignored",
      platform: "linux" as const,
      configRoot: "/test/config",
      cacheRoot: "/test/cache",
    },
    expected: unverified("/test/config", "/test/cache"),
  },
];

const TAP_CASES = [
  tapCase("Linux defaults", {}, "/home/ada", "linux"),
  tapCase("macOS defaults", {}, "/Users/ada", "darwin"),
  tapCase("Windows defaults", windowsEnv("C:\\Roaming", "C:\\Local"), "C:\\Users\\Ada", "win32"),
  tapCase(
    "absolute XDG precedence",
    { XDG_CONFIG_HOME: "/xdg/config", XDG_CACHE_HOME: "/xdg/cache" },
    "/home/ada",
    "linux",
  ),
  tapCase(
    "relative XDG fallback",
    { XDG_CONFIG_HOME: "relative/config", XDG_CACHE_HOME: "relative/cache" },
    "/home/ada",
    "linux",
  ),
  tapCase(
    "Windows application data precedence",
    {
      ...windowsEnv("C:\\Roaming", "C:\\Local"),
      XDG_CONFIG_HOME: "D:\\XdgConfig",
      XDG_CACHE_HOME: "D:\\XdgCache",
    },
    "C:\\Users\\Ada",
    "win32",
  ),
  tapCase(
    "Windows XDG fallback",
    { XDG_CONFIG_HOME: "D:\\XdgConfig", XDG_CACHE_HOME: "D:\\XdgCache" },
    "C:\\Users\\Ada",
    "win32",
  ),
  tapCase("config-only override", {}, "/home/ada", "linux", { configRoot: "/override/config" }),
  tapCase("cache-only override", {}, "/home/ada", "linux", { cacheRoot: "/override/cache" }),
  tapCase("paired overrides", {}, "/home/ada", "linux", {
    configRoot: "/override/config", cacheRoot: "/override/cache",
  }),
];

const TEMP_DIRS: string[] = [];
const TAP_ROOT_ERROR = "template tap root must be a real directory";

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("llmwiki unverified operator roots", () => {
  it.each(ROOT_CASES)("computes $name without claiming authorization", ({ inputs, expected }) => {
    const roots = resolveLlmwikiOperatorRoots(inputs);
    expect(roots).toEqual(expected);
    expect(Object.isFrozen(roots)).toBe(true);
  });

  it("captures changing environment leaves before checking or joining", () => {
    const reads = { config: 0, cache: 0 };
    const env = changingEnvironment(reads);
    const roots = resolveLlmwikiOperatorRoots({ env, home: "/home/ada", platform: "linux" });
    expect(reads).toEqual({ config: 1, cache: 1 });
    expect(roots).toEqual(unverified("/operator/config/llmwiki", "/operator/cache/llmwiki"));
  });

  it("keeps private-root behavior behind the TAP compatibility export", () => {
    expect(ensureTapPrivateRoot).toBe(ensurePrivateRoot);
  });
});

describe("template TAP path compatibility", () => {
  it.each(TAP_CASES)("preserves $name byte-for-byte", ({ inputs }) => {
    const paths = resolveTapPaths(inputs);
    expect(paths).toEqual(resolveLegacyTapPaths(inputs));
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it("matches the pinned baseline for a non-host platform override", () => {
    const inputs = nonHostTapInputs();
    expect(resolveTapPaths(inputs)).toEqual(resolveLegacyTapPaths(inputs));
  });

  it("captures accessor-backed inputs once and uses one path flavor", () => {
    const reads = emptyRootInputReads();
    const paths = resolveTapPaths(changingRootInputs(reads));
    expect(reads).toEqual({ env: 1, home: 1, platform: 1, configRoot: 1, cacheRoot: 1 });
    expect(paths.configRoot).toBe(path.join("/home/ada", ".config", "llmwiki"));
    expect(paths.cacheRoot).toBe(path.join("/home/ada", ".cache", "llmwiki", "templates"));
  });
});

describe("template TAP private-root leaf compatibility", () => {
  it("creates an absent directory leaf with owner-only POSIX mode", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "created");
    await ensureTapPrivateRoot(root);
    const stat = await lstat(root);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("repairs an existing directory leaf to mode 0700", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "existing");
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    await ensureTapPrivateRoot(root);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });

  it("rejects a regular-file leaf with the exact compatibility message", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "file");
    await writeFile(root, "not a directory");
    expect(await privateRootError(root)).toBe(TAP_ROOT_ERROR);
  });

  it("rejects a symlink leaf with the exact compatibility message", async () => {
    const parent = await temporaryDirectory();
    const target = path.join(parent, "target");
    const root = path.join(parent, "link");
    await mkdir(target);
    await directorySymlink(target, root);
    expect(await privateRootError(root)).toBe(TAP_ROOT_ERROR);
  });

  it("retains legacy TAP traversal through a symlinked parent", async () => {
    const parent = await temporaryDirectory();
    const target = path.join(parent, "real-parent");
    const alias = path.join(parent, "linked-parent");
    await mkdir(target);
    await directorySymlink(target, alias);
    await ensureTapPrivateRoot(path.join(alias, "child"));
    expect((await lstat(path.join(target, "child"))).isDirectory()).toBe(true);
  });
});

function unverified(configRoot: string, cacheRoot: string) {
  return { verification: "unverified" as const, configRoot, cacheRoot };
}

function windowsEnv(APPDATA: string, LOCALAPPDATA: string): NodeJS.ProcessEnv {
  return { APPDATA, LOCALAPPDATA };
}

function tapCase(
  name: string,
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
  overrides: { configRoot?: string; cacheRoot?: string } = {},
) {
  return { name, inputs: { env, home, platform, ...overrides } };
}

function nonHostTapInputs(): LlmwikiOperatorRootInputs {
  if (process.platform === "win32") {
    return { env: {}, home: "/home/ada", platform: "linux" };
  }
  return {
    env: windowsEnv("C:\\Roaming", "C:\\Local"),
    home: "C:\\Users\\Ada",
    platform: "win32",
  };
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-operator-roots-"));
  TEMP_DIRS.push(root);
  return root;
}

async function directorySymlink(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

async function privateRootError(root: string): Promise<string> {
  try {
    await ensureTapPrivateRoot(root);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected private-root compatibility failure");
}

function changingEnvironment(reads: { config: number; cache: number }): NodeJS.ProcessEnv {
  return Object.defineProperties({}, {
    XDG_CONFIG_HOME: {
      get: () => (++reads.config === 1 ? "/operator/config" : "../../escaped-config"),
    },
    XDG_CACHE_HOME: {
      get: () => (++reads.cache === 1 ? "/operator/cache" : "../../escaped-cache"),
    },
  }) as NodeJS.ProcessEnv;
}

type RootInputKey = keyof LlmwikiOperatorRootInputs;
type RootInputReads = Record<RootInputKey, number>;

function emptyRootInputReads(): RootInputReads {
  return { env: 0, home: 0, platform: 0, configRoot: 0, cacheRoot: 0 };
}

function changingRootInputs(reads: RootInputReads): LlmwikiOperatorRootInputs {
  const first: Record<RootInputKey, unknown> = {
    env: {}, home: "/home/ada", platform: "linux", configRoot: undefined,
    cacheRoot: undefined,
  };
  const later: Record<RootInputKey, unknown> = {
    ...first, platform: "win32", configRoot: "C:\\late-config", cacheRoot: "C:\\late-cache",
  };
  const inputs = {} as Record<string, unknown>;
  for (const key of Object.keys(first) as RootInputKey[]) {
    Object.defineProperty(inputs, key, {
      get: () => (++reads[key] === 1 ? first[key] : later[key]),
    });
  }
  return inputs as LlmwikiOperatorRootInputs;
}
