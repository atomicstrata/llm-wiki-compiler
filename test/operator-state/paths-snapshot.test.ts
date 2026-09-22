/**
 * @file test/operator-state/paths-snapshot.test.ts
 * @description Adversarial one-snapshot and primitive-output coverage for
 * unverified operator-root and legacy TAP path resolution.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveLlmwikiOperatorRoots,
  type LlmwikiOperatorRootInputs,
} from "../../src/operator-state/paths.js";
import { resolveTapPaths } from "../../src/profile/templates/taps/paths.js";

const ROOT_INPUT_ERROR = "operator root inputs are invalid or unreadable";

describe("operator-root lazy input capture", () => {
  it("uses paired explicit roots without reading env, home, or platform", () => {
    const reads = { config: 0, cache: 0, env: 0, home: 0, platform: 0 };
    const inputs = accessorInputs({
      configRoot: () => { reads.config += 1; return "/fixed/config"; },
      cacheRoot: () => { reads.cache += 1; return "/fixed/cache"; },
      env: () => throwing("SECRET_ENV"),
      home: () => throwing("SECRET_HOME"),
      platform: () => throwing("SECRET_PLATFORM"),
    });
    const roots = resolveLlmwikiOperatorRoots(inputs);
    expect(roots).toEqual(unverified("/fixed/config", "/fixed/cache"));
    expect(reads).toEqual({ config: 1, cache: 1, env: 0, home: 0, platform: 0 });
  });

  it("reads only the missing cache leg and skips home after absolute XDG", () => {
    const reads = { env: 0, home: 0, platform: 0, configLeaf: 0, cacheLeaf: 0 };
    const env = Object.defineProperties({}, {
      XDG_CONFIG_HOME: { get: () => { reads.configLeaf += 1; return throwing("CONFIG_LEAF"); } },
      XDG_CACHE_HOME: { get: () => { reads.cacheLeaf += 1; return "/xdg/cache"; } },
    });
    const inputs = accessorInputs({
      configRoot: () => "/fixed/config",
      cacheRoot: () => undefined,
      platform: () => { reads.platform += 1; return "linux"; },
      env: () => { reads.env += 1; return env; },
      home: () => { reads.home += 1; return throwing("SECRET_HOME"); },
    });
    expect(resolveLlmwikiOperatorRoots(inputs)).toEqual(
      unverified("/fixed/config", "/xdg/cache/llmwiki"),
    );
    expect(reads).toEqual({ env: 1, home: 0, platform: 1, configLeaf: 0, cacheLeaf: 1 });
  });

  it("does not read Windows-only leaves on Linux", () => {
    const env = Object.defineProperties({
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_CACHE_HOME: "/xdg/cache",
    }, {
      APPDATA: { get: () => throwing("IRRELEVANT_APPDATA_READ") },
      LOCALAPPDATA: { get: () => throwing("IRRELEVANT_LOCALAPPDATA_READ") },
    });
    expect(resolveLlmwikiOperatorRoots({ env, platform: "linux" })).toEqual(
      unverified("/xdg/config/llmwiki", "/xdg/cache/llmwiki"),
    );
  });

  it("short-circuits Windows XDG fallbacks after usable app-data roots", () => {
    const env = Object.defineProperties({
      APPDATA: "C:\\Roaming",
      LOCALAPPDATA: "C:\\Local",
    }, {
      XDG_CONFIG_HOME: { get: () => throwing("IRRELEVANT_XDG_CONFIG") },
      XDG_CACHE_HOME: { get: () => throwing("IRRELEVANT_XDG_CACHE") },
    });
    expect(resolveLlmwikiOperatorRoots({ env, platform: "win32" })).toEqual(
      unverified("C:\\Roaming\\llmwiki", "C:\\Local\\llmwiki\\cache"),
    );
  });

  it("uses Windows XDG fallbacks when app-data roots are unusable", () => {
    const reads = { app: 0, local: 0, config: 0, cache: 0 };
    const env = changingWindowsEnvironment(reads);
    expect(resolveLlmwikiOperatorRoots({ env, platform: "win32" })).toEqual(
      unverified("D:\\XdgConfig\\llmwiki", "D:\\XdgCache\\llmwiki"),
    );
    expect(reads).toEqual({ app: 1, local: 1, config: 1, cache: 1 });
  });

  it("captures each selected top-level and environment value once", () => {
    const reads = { config: 0, cache: 0, platform: 0, env: 0, xdgConfig: 0, xdgCache: 0 };
    const env = changingPosixEnvironment(reads);
    const inputs = accessorInputs({
      configRoot: () => { reads.config += 1; return undefined; },
      cacheRoot: () => { reads.cache += 1; return undefined; },
      platform: () => { reads.platform += 1; return reads.platform === 1 ? "linux" : "win32"; },
      env: () => { reads.env += 1; return env; },
      home: () => throwing("IRRELEVANT_HOME"),
    });
    expect(resolveLlmwikiOperatorRoots(inputs)).toEqual(
      unverified("/first/config/llmwiki", "/first/cache/llmwiki"),
    );
    expect(reads).toEqual({ config: 1, cache: 1, platform: 1, env: 1, xdgConfig: 1, xdgCache: 1 });
  });
});

describe("operator-root fixed primitive refusals", () => {
  it("translates a throwing top-level getter without reflecting its message", () => {
    const failure = rootFailure(accessorInputs({ configRoot: () => throwing("SECRET_TOP_LEVEL") }));
    expect(failure).toEqual({ name: "OperatorRootInputError", message: ROOT_INPUT_ERROR });
  });

  it("translates a throwing environment getter without reflecting its message", () => {
    const env = Object.defineProperty({}, "XDG_CONFIG_HOME", {
      get: () => throwing("SECRET_ENVIRONMENT_LEAF"),
    });
    const failure = rootFailure({ env, home: "/home/ada", platform: "linux" });
    expect(failure).toEqual({ name: "OperatorRootInputError", message: ROOT_INPUT_ERROR });
  });

  it.each([
    { name: "boxed root", inputs: { configRoot: new String("/boxed"), cacheRoot: "/cache" } },
    { name: "object root", inputs: { configRoot: { path: "/mutable" }, cacheRoot: "/cache" } },
    { name: "symbol root", inputs: { configRoot: Symbol("root"), cacheRoot: "/cache" } },
    { name: "function root", inputs: { configRoot: () => "/root", cacheRoot: "/cache" } },
    { name: "boxed home", inputs: { env: {}, home: new String("/home"), platform: "linux" } },
    { name: "object env leaf", inputs: { env: { XDG_CONFIG_HOME: { path: "/x" } }, home: "/h", platform: "linux" } },
    { name: "boxed platform", inputs: { env: {}, home: "/h", platform: new String("linux") } },
    { name: "unknown platform", inputs: { env: {}, home: "/h", platform: "not-a-platform" } },
    { name: "non-object env", inputs: { env: 7, home: "/h", platform: "linux" } },
  ])("rejects nonprimitive $name", ({ inputs }) => {
    expect(rootFailure(unsafeInputs(inputs))).toEqual({
      name: "OperatorRootInputError",
      message: ROOT_INPUT_ERROR,
    });
  });

  it("never preserves a mutable root reference inside a frozen result", () => {
    const mutable = { path: "/first" };
    const failure = rootFailure(unsafeInputs({ configRoot: mutable, cacheRoot: mutable }));
    mutable.path = "../../later";
    expect(failure).toEqual({ name: "OperatorRootInputError", message: ROOT_INPUT_ERROR });
  });

  it("translates revoked top-level and environment proxies", () => {
    const top = Proxy.revocable({}, {});
    const env = Proxy.revocable({}, {});
    top.revoke();
    env.revoke();
    expect(rootFailure(top.proxy as LlmwikiOperatorRootInputs).message).toBe(ROOT_INPUT_ERROR);
    expect(rootFailure({ env: env.proxy as NodeJS.ProcessEnv, platform: "linux" }).message).toBe(
      ROOT_INPUT_ERROR,
    );
  });

  it("rejects transparent top-level and environment proxies", () => {
    const top = new Proxy({ configRoot: "/config", cacheRoot: "/cache" }, {});
    const env = new Proxy({ XDG_CONFIG_HOME: "/config", XDG_CACHE_HOME: "/cache" }, {});
    expect(rootFailure(top).message).toBe(ROOT_INPUT_ERROR);
    expect(rootFailure({ env, platform: "linux" }).message).toBe(ROOT_INPUT_ERROR);
  });

  it("returns only primitive strings in a frozen record", () => {
    const roots = resolveLlmwikiOperatorRoots({ configRoot: "/config", cacheRoot: "/cache" });
    expect(typeof roots.configRoot).toBe("string");
    expect(typeof roots.cacheRoot).toBe("string");
    expect(Object.isFrozen(roots)).toBe(true);
  });
});

describe("TAP shared root-resolution context", () => {
  it("uses explicit roots without reading irrelevant env or home", () => {
    const reads = { config: 0, cache: 0, platform: 0, env: 0, home: 0 };
    const inputs = accessorInputs({
      configRoot: () => { reads.config += 1; return "/fixed/config"; },
      cacheRoot: () => { reads.cache += 1; return "/fixed/cache"; },
      platform: () => { reads.platform += 1; return "linux"; },
      env: () => { reads.env += 1; return throwing("SECRET_ENV"); },
      home: () => { reads.home += 1; return throwing("SECRET_HOME"); },
    });
    const paths = resolveTapPaths(inputs);
    expect(paths).toEqual(tapPaths("/fixed/config", "/fixed/cache"));
    expect(reads).toEqual({ config: 1, cache: 1, platform: 1, env: 0, home: 0 });
  });

  it("uses one validated platform for every TAP leaf", () => {
    let platformReads = 0;
    const inputs = accessorInputs({
      configRoot: () => "C:\\Config",
      cacheRoot: () => "C:\\Cache",
      platform: () => { platformReads += 1; return platformReads === 1 ? "win32" : "linux"; },
    });
    const paths = resolveTapPaths(inputs);
    expect(platformReads).toBe(1);
    expect(paths.stateFile).toBe(path.join("C:\\Config", "template-taps.json"));
    expect(paths.lockFile).toBe(path.join("C:\\Config", "template-taps.lock"));
  });

  it("requires platform even when both TAP roots are explicit", () => {
    const inputs = accessorInputs({
      configRoot: () => "/config",
      cacheRoot: () => "/cache",
      platform: () => throwing("SECRET_PLATFORM"),
    });
    expect(tapFailure(inputs)).toEqual({ name: "OperatorRootInputError", message: ROOT_INPUT_ERROR });
  });

  it("rejects a mutable explicit TAP cache root", () => {
    const mutable = { path: "/cache" };
    expect(tapFailure(unsafeInputs({
      configRoot: "/config", cacheRoot: mutable, platform: "linux",
    }))).toEqual({ name: "OperatorRootInputError", message: ROOT_INPUT_ERROR });
  });

  it("returns only primitive strings in a frozen TAP record", () => {
    const paths = resolveTapPaths({
      configRoot: "/config", cacheRoot: "/cache", platform: "linux",
    });
    expect(Object.values(paths).every((value) => typeof value === "string")).toBe(true);
    expect(Object.isFrozen(paths)).toBe(true);
  });
});

type InputGetter = () => unknown;

function accessorInputs(getters: Partial<Record<keyof LlmwikiOperatorRootInputs, InputGetter>>) {
  const inputs: Record<string, unknown> = {};
  for (const [key, getter] of Object.entries(getters)) {
    Object.defineProperty(inputs, key, { get: getter });
  }
  return inputs as LlmwikiOperatorRootInputs;
}

function changingPosixEnvironment(
  reads: { xdgConfig: number; xdgCache: number },
): NodeJS.ProcessEnv {
  return Object.defineProperties({}, {
    XDG_CONFIG_HOME: { get: () => (++reads.xdgConfig === 1 ? "/first/config" : "relative") },
    XDG_CACHE_HOME: { get: () => (++reads.xdgCache === 1 ? "/first/cache" : "relative") },
  }) as NodeJS.ProcessEnv;
}

function changingWindowsEnvironment(
  reads: { app: number; local: number; config: number; cache: number },
): NodeJS.ProcessEnv {
  return Object.defineProperties({}, {
    APPDATA: { get: () => { reads.app += 1; return "relative"; } },
    LOCALAPPDATA: { get: () => { reads.local += 1; return "relative"; } },
    XDG_CONFIG_HOME: { get: () => { reads.config += 1; return "D:\\XdgConfig"; } },
    XDG_CACHE_HOME: { get: () => { reads.cache += 1; return "D:\\XdgCache"; } },
  }) as NodeJS.ProcessEnv;
}

function rootFailure(inputs: LlmwikiOperatorRootInputs): { name: string; message: string } {
  try {
    resolveLlmwikiOperatorRoots(inputs);
  } catch (error) {
    return { name: (error as Error).name, message: (error as Error).message };
  }
  throw new Error("expected operator-root input refusal");
}

function tapFailure(inputs: LlmwikiOperatorRootInputs): { name: string; message: string } {
  try {
    resolveTapPaths(inputs);
  } catch (error) {
    return { name: (error as Error).name, message: (error as Error).message };
  }
  throw new Error("expected TAP input refusal");
}

function unsafeInputs(values: Record<string, unknown>): LlmwikiOperatorRootInputs {
  return values as LlmwikiOperatorRootInputs;
}

function throwing(message: string): never {
  throw new Error(message);
}

function unverified(configRoot: string, cacheRoot: string) {
  return { verification: "unverified" as const, configRoot, cacheRoot };
}

function tapPaths(configRoot: string, cacheRoot: string) {
  return {
    configRoot,
    cacheRoot,
    stateFile: path.join(configRoot, "template-taps.json"),
    lockFile: path.join(configRoot, "template-taps.lock"),
  };
}
