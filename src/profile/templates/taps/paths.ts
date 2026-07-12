/**
 * @file src/profile/templates/taps/paths.ts
 * @description Platform operator config/cache paths with deterministic test overrides.
 */
import os from "node:os";
import path from "node:path";

/** Testable environment and home inputs for platform path resolution. */
export interface TapPathInputs {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  configRoot?: string;
  cacheRoot?: string;
}

/** Resolved private roots and authoritative/cache leaves. */
export interface TapPaths {
  configRoot: string;
  cacheRoot: string;
  stateFile: string;
  lockFile: string;
}

/** Resolve platform-conventional roots without reading or writing them. */
export function resolveTapPaths(inputs: TapPathInputs = {}): TapPaths {
  const env = inputs.env ?? process.env;
  const home = inputs.home ?? os.homedir();
  const platform = inputs.platform ?? process.platform;
  const configRoot = inputs.configRoot ?? defaultConfigRoot(platform, env, home);
  const cacheRoot = inputs.cacheRoot ?? defaultCacheRoot(platform, env, home);
  return {
    configRoot,
    cacheRoot,
    stateFile: path.join(configRoot, "template-taps.json"),
    lockFile: path.join(configRoot, "template-taps.lock"),
  };
}

function defaultConfigRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "llmwiki");
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "llmwiki");
  return path.join(home, ".config", "llmwiki");
}

function defaultCacheRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "llmwiki", "cache", "templates");
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "llmwiki", "templates");
  return path.join(home, ".cache", "llmwiki", "templates");
}
