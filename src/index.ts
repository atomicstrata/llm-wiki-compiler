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
