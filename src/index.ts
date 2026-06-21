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
  ListPagesProfileBlock,
} from "./pages/list.js";

export type {
  JsonExportDocument,
  ExportJsonOptions,
  JsonExportProfileBlock,
} from "./export/json-export.js";

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
// WriteStatus is part of IngestResult — re-exported so callers needn't deep-import utils/types.
export type { WriteStatus } from "./utils/types.js";

// OKF export/import — report types and typed errors for SDK consumers.
export type { OkfExportReport } from "./export/okf/run.js";
export type { OkfImportReport, OkfImportSkip, OkfImportedPage } from "./import/run.js";
export { LockUnavailableError, QueueFullError } from "./import/run-errors.js";

// @experimental — programmatic non-default entity-page staging loop. The
// `createWiki()` facade exposes `stageEntityPage`/`promoteStagedPage`; these are
// the input/return types consumers need. The lower-level `stageEntityPage(root,…)`
// and `promoteCandidateUnderLock` forms stay internal. API may change.
//
// Read-integration status: typed entity pages are a WRITE SUBSTRATE — a promoted
// page is surfaced in `status`, the JSON export, and the wiki INDEX, but NOT YET
// in interlinking, semantic search/embeddings, the MOC, or the viewer (planned).
export type { SdkStageEntityPageInput } from "./trust/staging.js";
export { StagingRequiresProfileError } from "./trust/staging.js";
export type {
  StagedChange,
  CandidateKind,
  HeldReasonCode,
  RelationRef,
  ArtifactRef,
  WorkflowRunRef,
} from "./trust/staged-change.js";
// Planner sub-types named by `StagedChange.target` / `.planned` so the staged
// surface is fully nameable by consumers (the typed `EntityRef` target especially).
export type {
  EntityRef,
  RawPageRef,
  MutationTarget,
  MutationOperation,
  MutationKind,
  PlannedMutation,
  MutationProvenance,
} from "./trust/planner.js";
export type { TrustDecision } from "./trust/decision.js";

// Profile pack TYPES only — the loader stays internal (no `loadProfile` export).
export type {
  ProfilePack,
  EntityId,
  EntityPageRef,
  EntityPageView,
  EntityProblemView,
  LoadedProfile,
  SlugSafe,
} from "./profile/types.js";
