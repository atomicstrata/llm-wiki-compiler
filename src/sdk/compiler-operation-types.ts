/**
 * @file Types for running a whole-store compiler operation with host-supplied
 * model callbacks. The host owns model routing and the callback lifecycle.
 */
import type { LLMMessage, LLMTool } from "../utils/provider.js";

/** Non-credential model identity used for provenance and reuse. */
export interface CompilerModelIdentity {
  readonly provider: string;
  readonly model: string;
}

/** Model calls with explicit purpose at the compiler call site. */
export type CompilerChatPurpose =
  | "compile.extract-concepts"
  | "compile.generate-page"
  | "compile.generate-seed-page"
  | "query.select-pages"
  | "query.answer";

/** One non-streaming completion or a single compiler-defined forced tool. */
export interface CompilerChatCall {
  readonly purpose: CompilerChatPurpose;
  readonly system: string;
  readonly messages: readonly Readonly<LLMMessage>[];
  readonly tool?: Readonly<LLMTool>;
}

/** An ordered batch of documents or one retrieval question. */
export interface CompilerEmbeddingCall {
  readonly purpose: "compile.embed-documents" | "query.embed-question";
  readonly inputs: readonly string[];
}

/** Model callbacks and identities for a single compile or query. */
export interface CompilerOperationModels {
  readonly chat: CompilerModelIdentity;
  readonly extraction?: CompilerModelIdentity;
  readonly embedding: CompilerModelIdentity & {
    readonly dimensions: number;
    /** A SHA-256 identity for the vector space, stable across compatible runs. */
    readonly fingerprint: string;
  };
  readonly embeddingBatchSize: number;
  readonly complete: (request: CompilerChatCall) => Promise<string>;
  readonly embed: (request: CompilerEmbeddingCall) => Promise<readonly (readonly number[])[]>;
}

/** A host-owned immutable query generation identified by its authority bytes. */
export interface CompilerQueryGeneration {
  readonly indexSha256: string;
  readonly storeSha256: string;
}

/** Prompt options chosen by the host for this operation. */
export interface CompilerOperationContent {
  readonly outputLanguage?: string | null;
  readonly promptBudgetChars?: number;
  readonly sourcesSection?: boolean;
}

/** Inputs captured for a single operation over a host-owned working copy. */
export type CompilerOperationRequest = Readonly<{
  root: string;
  models: CompilerOperationModels;
  content?: CompilerOperationContent;
  signal?: AbortSignal;
}> & (
  | Readonly<{ kind: "compile"; concurrency?: number; systemPolicy?: string }>
  | Readonly<{
      kind: "query";
      question: string;
      generation: CompilerQueryGeneration;
      pageScope?: readonly string[];
      debug?: boolean;
    }>
);
