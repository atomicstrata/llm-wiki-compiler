/**
 * @file Public host-driven compile and read-only query over the ordinary
 * compiler bodies and one operation-scoped model authority.
 */
import path from "node:path";
import { generateAnswer } from "../commands/query.js";
import { compileAndReport } from "../compiler/index.js";
import { indexedActive } from "../indexed/routing.js";
import { assertScaleReady } from "../scale/gate.js";
import { withQuiet } from "../utils/output.js";
import { hasProviderOverride } from "../utils/provider.js";
import type { CompileResult, QueryResult } from "../utils/types.js";
import { compilerModelScope, CompilerModelScope, CompilerOperationError } from "./compiler-model-scope.js";
import { compilerStoreIsComplete, readCompilerQueryStore } from "./compiler-operation-store.js";
import type { CompilerOperationModels, CompilerOperationRequest } from "./compiler-operation-types.js";

type CompileRequest = Extract<CompilerOperationRequest, { kind: "compile" }>;
type QueryRequest = Extract<CompilerOperationRequest, { kind: "query" }>;
const SHA256 = /^[a-f0-9]{64}$/;

/** Check the settings consumed by the shared pipeline before disk or model I/O. */
function validateModels(models: CompilerOperationModels): void {
  const { embedding, embeddingBatchSize } = models;
  const identity = [models.chat, models.extraction ?? models.chat, embedding];
  const identitiesValid = identity.every(({ provider, model }) => typeof provider === "string" && provider.length > 0
    && typeof model === "string" && model.length > 0);
  if (!identitiesValid || !validEmbeddingIdentity(embedding, embeddingBatchSize)
    || typeof models.complete !== "function" || typeof models.embed !== "function") {
    throw new CompilerOperationError("operation_invalid");
  }
}

/** Require a stable vector-space fingerprint and positive integer shape. */
function validEmbeddingIdentity(embedding: CompilerOperationModels["embedding"], batchSize: number): boolean {
  return SHA256.test(embedding.fingerprint)
    && Number.isSafeInteger(embedding.dimensions) && embedding.dimensions > 0
    && Number.isSafeInteger(batchSize) && batchSize > 0;
}

/** Run compilation and require a complete generation before returning it. */
async function runCompile(scope: CompilerModelScope, root: string, request: CompileRequest): Promise<CompileResult> {
  const result = await compileAndReport(root, {
    embeddings: true, systemPolicy: request.systemPolicy, concurrency: request.concurrency,
  });
  scope.check();
  if (result.mode === "batch" || result.errors.length || result.candidates?.length
    || !(await compilerStoreIsComplete(root, scope.models.embedding))) {
    throw new CompilerOperationError("compile_incomplete");
  }
  return result;
}

/** Run against a pinned snapshot with strict embedding and retrieval failure handling. */
async function runQuery(scope: CompilerModelScope, root: string, request: QueryRequest): Promise<QueryResult> {
  const store = await readCompilerQueryStore(root, request.generation, scope.models.embedding);
  scope.check();
  scope.pinStore(store);
  const result = await generateAnswer(root, request.question, {
    embeddingFailure: "throw", pageScope: request.pageScope, debug: request.debug,
  });
  scope.check();
  if (result.warnings?.length) throw new CompilerOperationError("retrieval_context_incomplete");
  return result;
}

/** Capture the supported operation options before any asynchronous work. */
function captureOperation(request: CompilerOperationRequest): CompilerOperationRequest {
  switch (request.kind) {
    case "compile":
      if (Object.hasOwn(request, "review")) throw new CompilerOperationError("unsupported_option");
      return { ...request };
    case "query":
      return captureQuery(request);
    default:
      throw new CompilerOperationError("unsupported_option");
  }
}

/** Snapshot both retrieval digests and the optional scope before work starts. */
function captureQuery(request: QueryRequest): QueryRequest {
  const { generation, question, pageScope } = request;
  if (Object.hasOwn(request, "save") || Object.hasOwn(request, "review")) throw new CompilerOperationError("unsupported_option");
  if (!SHA256.test(generation.indexSha256) || !SHA256.test(generation.storeSha256) || typeof question !== "string") {
    throw new CompilerOperationError("operation_invalid");
  }
  return { ...request, generation: { ...generation }, pageScope: pageScope && [...pageScope] };
}

/** Run a whole-store compile on a disposable, host-owned working copy. */
export function runCompilerOperation(request: CompileRequest): Promise<CompileResult>;
/** Run a byte-read-only query on an immutable, host-owned generation. */
export function runCompilerOperation(request: QueryRequest): Promise<QueryResult>;
/** Run exactly one operation with explicit callbacks and no ambient model fallback. */
export async function runCompilerOperation(request: CompilerOperationRequest): Promise<CompileResult | QueryResult> {
  if (compilerModelScope() || hasProviderOverride()) throw new CompilerOperationError("operation_active");
  const captured = captureOperation(request);
  const root = path.resolve(captured.root);
  const scope = new CompilerModelScope(captured);
  validateModels(scope.models);
  return scope.run(() => withQuiet(async () => {
    if (await indexedActive(root)) throw new CompilerOperationError("unsupported_option");
    if (captured.kind === "query") return runQuery(scope, root, captured);
    await assertScaleReady(root);
    scope.check();
    return runCompile(scope, root, captured);
  }));
}
