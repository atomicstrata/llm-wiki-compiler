/**
 * Schema layer entry point.
 *
 * Re-exports the public surface used by the compiler, linter, and CLI so
 * consumers import from a single place without reaching into submodules.
 */

export {
  type PageKindRule,
  type SchemaConfig,
  type SeedPage,
  PAGE_KINDS,
} from "./types.js";
export { buildDefaultSchema } from "./defaults.js";
export { loadSchema, loadSchemaFrom, defaultSchemaInitPath, schemaFromText } from "./loader.js";
export {
  resolvePageKind,
  serializeSchemaToYaml,
  countWikilinks,
} from "./helpers.js";
