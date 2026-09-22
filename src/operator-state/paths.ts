/**
 * @file src/operator-state/paths.ts
 * @description Pure platform-aware resolution of candidate llmwiki operator
 * roots. Caller-controlled values are captured lazily as primitives and every
 * result remains unverified until a separate filesystem authority boundary.
 */
import os from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";

const ROOT_INPUT_ERROR = "operator root inputs are invalid or unreadable";
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set([
  "aix", "android", "darwin", "freebsd", "haiku", "linux",
  "openbsd", "sunos", "win32", "cygwin", "netbsd",
]);
const PLATFORM_AWARE_POLICY = "platform-aware";
const LEGACY_TAP_POLICY = "legacy-tap";
type RootPathPolicy = typeof PLATFORM_AWARE_POLICY | typeof LEGACY_TAP_POLICY;

/**
 * Path-computation inputs for platform selection and TAP compatibility tests.
 * None of these caller-selectable values establish filesystem authority.
 */
export interface LlmwikiOperatorRootInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly configRoot?: string;
  readonly cacheRoot?: string;
}

/** Purely computed roots that have not passed host filesystem authorization. */
export interface UnverifiedLlmwikiOperatorRoots {
  readonly verification: "unverified";
  readonly configRoot: string;
  readonly cacheRoot: string;
}

/** Shared unverified context consumed by legacy TAP path projection. */
export interface UnverifiedLlmwikiOperatorPathContext {
  readonly roots: UnverifiedLlmwikiOperatorRoots;
  readonly platform: NodeJS.Platform;
  readonly cacheRootWasExplicit: boolean;
}

/** Fixed refusal for unreadable or nonprimitive root-resolution inputs. */
class OperatorRootInputError extends Error {
  constructor() {
    super(ROOT_INPUT_ERROR);
    this.name = "OperatorRootInputError";
  }
}

/**
 * Compute generic llmwiki roots without reading, creating, or authorizing them.
 * Provider stores must consume Task 3's opaque authorized-root type instead.
 */
export function resolveLlmwikiOperatorRoots(
  inputs: LlmwikiOperatorRootInputs = {},
): UnverifiedLlmwikiOperatorRoots {
  return withFixedInputError(() => resolveContext(inputs, PLATFORM_AWARE_POLICY).roots);
}

/** Resolve one shared primitive context for TAP leaves without rereading inputs. */
export function resolveLlmwikiOperatorPathContext(
  inputs: LlmwikiOperatorRootInputs = {},
): UnverifiedLlmwikiOperatorPathContext {
  return withFixedInputError(() => {
    const context = resolveContext(inputs, LEGACY_TAP_POLICY);
    if (context.platform === undefined) throw new OperatorRootInputError();
    return Object.freeze({
      roots: context.roots,
      platform: context.platform,
      cacheRootWasExplicit: context.cacheRootWasExplicit,
    });
  });
}

interface RootResolutionContext {
  readonly roots: UnverifiedLlmwikiOperatorRoots;
  readonly platform: NodeJS.Platform | undefined;
  readonly cacheRootWasExplicit: boolean;
}

function resolveContext(
  inputs: LlmwikiOperatorRootInputs,
  policy: RootPathPolicy,
): RootResolutionContext {
  validateInputRecord(inputs);
  const configRoot = optionalString(inputs.configRoot);
  const cacheRoot = optionalString(inputs.cacheRoot);
  const cacheRootWasExplicit = cacheRoot !== undefined;
  const platformRequired = policy === LEGACY_TAP_POLICY;
  if (!platformRequired && configRoot !== undefined && cacheRoot !== undefined) {
    return context(frozenRoots(configRoot, cacheRoot), undefined, true);
  }
  const platform = validatedPlatform(inputs.platform);
  if (configRoot !== undefined && cacheRoot !== undefined) {
    return context(frozenRoots(configRoot, cacheRoot), platform, true);
  }
  const env = validatedEnvironment(inputs.env);
  const home = lazyHome(inputs);
  const resolvedConfig = configRoot ?? defaultConfigRoot(policy, platform, env, home);
  const resolvedCache = cacheRoot ?? defaultCacheRoot(policy, platform, env, home);
  return context(frozenRoots(resolvedConfig, resolvedCache), platform, cacheRootWasExplicit);
}

function context(
  roots: UnverifiedLlmwikiOperatorRoots,
  platform: NodeJS.Platform | undefined,
  cacheRootWasExplicit: boolean,
): RootResolutionContext {
  return Object.freeze({ roots, platform, cacheRootWasExplicit });
}

function frozenRoots(configRoot: string, cacheRoot: string): UnverifiedLlmwikiOperatorRoots {
  return Object.freeze({ verification: "unverified", configRoot, cacheRoot });
}

function defaultConfigRoot(
  policy: RootPathPolicy,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: () => string,
): string {
  if (platform === "win32") {
    const appData = environmentString(env, "APPDATA");
    if (absolute(policy, platform, appData)) return join(policy, platform, appData, "llmwiki");
  }
  const xdgConfig = environmentString(env, "XDG_CONFIG_HOME");
  if (absolute(policy, platform, xdgConfig)) return join(policy, platform, xdgConfig, "llmwiki");
  return join(policy, platform, home(), ".config", "llmwiki");
}

function defaultCacheRoot(
  policy: RootPathPolicy,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: () => string,
): string {
  if (platform === "win32") {
    const localAppData = environmentString(env, "LOCALAPPDATA");
    if (absolute(policy, platform, localAppData)) {
      return join(policy, platform, localAppData, "llmwiki", "cache");
    }
  }
  const xdgCache = environmentString(env, "XDG_CACHE_HOME");
  if (absolute(policy, platform, xdgCache)) return join(policy, platform, xdgCache, "llmwiki");
  return join(policy, platform, home(), ".cache", "llmwiki");
}

function lazyHome(inputs: LlmwikiOperatorRootInputs): () => string {
  let captured = false;
  let home = "";
  return () => {
    if (!captured) {
      const provided = optionalString(inputs.home);
      home = provided ?? requiredString(os.homedir());
      captured = true;
    }
    return home;
  };
}

function validatedPlatform(value: unknown): NodeJS.Platform {
  const platform = value === undefined ? process.platform : requiredString(value);
  if (!SUPPORTED_PLATFORMS.has(platform)) throw new OperatorRootInputError();
  return platform as NodeJS.Platform;
}

function validatedEnvironment(value: unknown): NodeJS.ProcessEnv {
  const env = value === undefined ? process.env : value;
  if (env === null || typeof env !== "object" || utilTypes.isProxy(env) || Array.isArray(env)) {
    throw new OperatorRootInputError();
  }
  return env as NodeJS.ProcessEnv;
}

function validateInputRecord(value: unknown): void {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new OperatorRootInputError();
  }
}

function environmentString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return optionalString(env[key]);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new OperatorRootInputError();
  return value;
}

function withFixedInputError<Result>(action: () => Result): Result {
  try {
    return action();
  } catch {
    throw new OperatorRootInputError();
  }
}

function absolute(
  policy: RootPathPolicy,
  platform: NodeJS.Platform,
  value: string | undefined,
): value is string {
  return value !== undefined && absolutePathApi(policy, platform).isAbsolute(value);
}

function join(policy: RootPathPolicy, platform: NodeJS.Platform, ...parts: string[]): string {
  const pathApi = policy === LEGACY_TAP_POLICY ? path : platformPathApi(platform);
  return pathApi.join(...parts);
}

function absolutePathApi(policy: RootPathPolicy, platform: NodeJS.Platform): typeof path {
  if (policy === LEGACY_TAP_POLICY) return platform === "win32" ? path.win32 : path;
  return platformPathApi(platform);
}

function platformPathApi(platform: NodeJS.Platform): typeof path {
  return platform === "win32" ? path.win32 : path.posix;
}
