/**
 * @file src/profile/templates/taps/paths.ts
 * @description Legacy TAP leaves derived from unverified platform root
 * computation without reclassifying those paths as provider authority.
 */
import path from "node:path";
import {
  resolveLlmwikiOperatorPathContext,
  type LlmwikiOperatorRootInputs,
} from "../../../operator-state/paths.js";

/** TAP computation knobs; these values never establish provider authority. */
export interface TapPathInputs extends LlmwikiOperatorRootInputs {}

/** Resolved TAP config/cache leaves; no provider authorization is implied. */
export interface TapPaths {
  readonly configRoot: string;
  readonly cacheRoot: string;
  readonly stateFile: string;
  readonly lockFile: string;
}

/** Resolve unverified TAP paths without reading, writing, or authorizing them. */
export function resolveTapPaths(inputs: TapPathInputs = {}): TapPaths {
  const context = resolveLlmwikiOperatorPathContext(inputs);
  const { roots } = context;
  const cacheRoot = context.cacheRootWasExplicit
    ? roots.cacheRoot
    : path.join(roots.cacheRoot, "templates");
  return Object.freeze({
    configRoot: roots.configRoot,
    cacheRoot,
    stateFile: path.join(roots.configRoot, "template-taps.json"),
    lockFile: path.join(roots.configRoot, "template-taps.lock"),
  });
}
