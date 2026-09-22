/**
 * @file src/operations-packs/parse-alias.ts
 * @description Parser for one AliasDescriptorV1 (design section 19.1) to its full
 * spec shape. It enforces the required-iff-agent rule for transportSurface: an
 * agent alias must name its underlying authority transport, and a non-agent alias
 * must not. Alias defaults are ordinary bounded input values whose schema
 * conformance is checked by the deferred resolver (19.2); a declared deprecation
 * notice is refused because its grammar is under-specified in v3.
 */

import { enumValue, exact, record, type JsonRecord } from "../operation-bundles/manifest-values.js";
import { assertLocale } from "../products/ids.js";
import { MAX_ACTION_INPUT_FIELDS } from "./constants.js";
import { assertActionId, assertAliasId, assertSlug, assertToken } from "./ids.js";
import { PackDeferredError, PackParseError } from "./problems.js";
import type { AliasDescriptorV1, PackExperienceSurfaceV1 } from "./types.js";
import { inputValue, parseObjectMap } from "./values.js";

const EXPERIENCE_SURFACES = ["cli", "sdk", "mcp", "viewer", "agent"] as const;
const INVOCATION_SURFACES = ["cli", "sdk", "mcp", "viewer"] as const;
const ALIAS_REQUIRED = ["aliasId", "surface", "token", "actionId"] as const;
const ALIAS_OPTIONAL = ["transportSurface", "host", "locale", "defaultInputs", "deprecation"] as const;

/** Enforce the transportSurface required-iff-agent rule (section 19.1). */
function parseTransport(
  node: JsonRecord, surface: PackExperienceSurfaceV1, label: string,
): Pick<AliasDescriptorV1, "transportSurface"> {
  const declared = node.transportSurface !== undefined;
  if (surface === "agent") {
    if (!declared) throw new PackParseError(`${label} agent alias must declare transportSurface`);
    return { transportSurface: enumValue(node.transportSurface, INVOCATION_SURFACES, `${label}.transportSurface`) };
  }
  if (declared) throw new PackParseError(`${label} non-agent alias must not declare transportSurface`);
  return {};
}

/** Parse the optional host, locale, and declared default inputs. */
function parseAliasOptional(node: JsonRecord, label: string): Pick<AliasDescriptorV1, "host" | "locale" | "defaultInputs"> {
  const out: Pick<AliasDescriptorV1, "host" | "locale" | "defaultInputs"> = {};
  if (node.host !== undefined) out.host = assertSlug(node.host);
  if (node.locale !== undefined) out.locale = assertLocale(node.locale);
  if (node.defaultInputs !== undefined) {
    out.defaultInputs = parseObjectMap(node.defaultInputs, `${label}.defaultInputs`, MAX_ACTION_INPUT_FIELDS, assertSlug, inputValue);
  }
  return out;
}

/** Parse and structurally validate one alias descriptor (section 19.1). */
export function parseAlias(value: unknown, label: string): AliasDescriptorV1 {
  const node = record(value, label);
  exact(node, ALIAS_REQUIRED, ALIAS_OPTIONAL);
  if (node.deprecation !== undefined) throw new PackDeferredError("alias deprecation notice (grammar under-specified)");
  const surface = enumValue(node.surface, EXPERIENCE_SURFACES, `${label}.surface`);
  return {
    aliasId: assertAliasId(node.aliasId),
    surface,
    token: assertToken(node.token),
    actionId: assertActionId(node.actionId),
    ...parseTransport(node, surface, label),
    ...parseAliasOptional(node, label),
  };
}
