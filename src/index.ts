/**
 * @file src/index.ts
 * @description Public SDK surface for llm-wiki-compiler.
 *
 * Re-exports the stable, consumer-facing types and error classes that form the
 * library API. CLI internals (commander setup, prompts, viewer server) are
 * intentionally excluded — they live only in src/cli.ts and are not part of
 * the programmatic API.
 *
 * Consumers can import types and errors directly:
 *   import type { Page, PageRef } from "llm-wiki-compiler";
 *   import { ProviderUnavailableError } from "llm-wiki-compiler";
 */

export type {
  Page,
  PageRef,
  PageDirectory,
  ListPagesOptions,
  ListPagesResult,
} from "./pages/list.js";

export type { JsonExportDocument } from "./export/json-export.js";

export {
  ProviderUnavailableError,
  UnknownProviderError,
} from "./utils/provider-guard.js";

export { createWiki } from "./sdk/wiki.js";
export type { Wiki, CreateWikiOptions, SdkCompileOptions, ContextPackOptions } from "./sdk/types.js";

// Result/input types for the Wiki facade methods, re-exported so typed
// consumers don't have to deep-import from internal module paths.
export type { IngestResult, CompileResult, QueryResult } from "./utils/types.js";
export type { IngestTextInput } from "./commands/ingest.js";
export type { LintSummary } from "./linter/types.js";
export type { ContextPack } from "./context/types.js";
export type { EvalReport } from "./eval/types.js";
export type { WikiStatus } from "./status/collect.js";
export type { PageRecord } from "./pages/read.js";
export type { SourceRecord, ListSourcesOptions, ListSourcesResult } from "./sources/store.js";
export type { WriteStatus } from "./utils/types.js";
