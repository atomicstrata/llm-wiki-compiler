/**
 * @file src/capability-providers/schema/compile.ts
 * @description Compiles only parser-minted closed schemas into opaque,
 * host-owned validators bound to the repository's one canonical digest.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { parseSha256Digest } from "../ids.js";
import { requireParsedClosedProviderSchema } from "./parse.js";
import { registerCompiledClosedProviderSchema } from "./validate.js";
import type {
  CompiledClosedProviderSchemaV1,
  ParsedClosedProviderSchemaV1,
} from "./types.js";

/** Compile one trusted parse result; raw package JSON is refused. */
export function compileClosedProviderSchema(
  parsed: ParsedClosedProviderSchemaV1,
): CompiledClosedProviderSchemaV1 {
  const schema = requireParsedClosedProviderSchema(parsed);
  const digest = parseSha256Digest(canonicalDigest(schema));
  return registerCompiledClosedProviderSchema(digest, schema);
}
