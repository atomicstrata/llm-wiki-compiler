/**
 * @file Operation-local model callbacks. A captured scope owns admission even
 * after the operation closes, so detached continuations cannot fall through to
 * the process model configuration.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { assertEveryVectorValid } from "../utils/embeddings-validate.js";
import type { EmbeddingStoreV3 } from "../utils/embeddings-store.js";
import type { EmbeddingInputType, LLMProvider } from "../utils/provider.js";
import type {
  CompilerChatCall, CompilerEmbeddingCall, CompilerOperationContent, CompilerOperationModels, CompilerOperationRequest,
} from "./compiler-operation-types.js";

const storage = new AsyncLocalStorage<CompilerModelScope>();

/** Raised when a supported scope cannot admit or finish an operation. */
export class CompilerOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CompilerOperationError";
  }
}

/** Current scope, including a closed scope inherited by a continuation. */
export function compilerModelScope(): CompilerModelScope | undefined {
  return storage.getStore();
}

/** One scope's immutable callback bindings and first failure. */
export class CompilerModelScope {
  readonly models: CompilerOperationModels;
  readonly content: Readonly<CompilerOperationContent>;
  private closed = false;
  private failure: { readonly error: unknown } | undefined;
  private snapshot: EmbeddingStoreV3 | undefined;
  private question: { text: string; vector: Promise<number[][]> } | undefined;

  constructor(request: CompilerOperationRequest) {
    this.kind = request.kind;
    this.signal = request.signal;
    this.content = Object.freeze({ ...request.content });
    const { models } = request;
    this.models = Object.freeze({
      chat: Object.freeze({ ...models.chat }),
      ...(models.extraction && { extraction: Object.freeze({ ...models.extraction }) }),
      embedding: Object.freeze({ ...models.embedding }),
      embeddingBatchSize: models.embeddingBatchSize,
      complete: models.complete,
      embed: models.embed,
    });
  }

  readonly kind: CompilerOperationRequest["kind"];
  readonly signal: AbortSignal | undefined;

  /** Latch the first failure even when the compiler catches it. */
  refuse(error: unknown): never {
    this.failure ??= { error };
    throw this.failure.error;
  }

  /** Check for failures, aborts, and late use of the operation scope. */
  check(): void {
    if (this.failure) throw this.failure.error;
    if (this.signal?.aborted) this.refuse(new CompilerOperationError("operation_aborted"));
    if (this.closed) this.refuse(new CompilerOperationError("operation_closed"));
  }

  /** Install the scope for the complete pipeline and close admission on exit. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    try {
      const result = await storage.run(this, operation);
      this.check();
      return result;
    } catch (error) {
      return this.refuse(error);
    } finally {
      this.closed = true;
    }
  }

  /** Save the parsed bytes checked during retrieval preflight. */
  pinStore(store: EmbeddingStoreV3): void {
    this.snapshot = store;
  }

  /** Supply retrieval with the exact checked snapshot. */
  // Accessed through compilerModelScope() by the retrieval loader.
  // fallow-ignore-next-line unused-class-member
  get retrievalStore(): EmbeddingStoreV3 | undefined {
    return this.snapshot;
  }

  /** Dispatch a tagged completion exactly once, without provider retries. */
  // Accessed through compilerModelScope() by the shared chat utility.
  // fallow-ignore-next-line unused-class-member
  async complete(request: CompilerChatCall): Promise<string> {
    this.check();
    if (!request.purpose.startsWith(this.kind + ".")) this.refuse(new CompilerOperationError("unsupported_purpose"));
    try {
      const output = await this.models.complete(request);
      this.check();
      if (typeof output !== "string") this.refuse(new CompilerOperationError("model_output_invalid"));
      return output;
    } catch (error) {
      return this.refuse(error);
    }
  }

  /** Retrieve a batch with exact width and cardinality checks. */
  private async embed(request: CompilerEmbeddingCall): Promise<number[][]> {
    this.check();
    try {
      const output = await this.models.embed(request);
      this.check();
      if (!Array.isArray(output) || output.length !== request.inputs.length) {
        this.refuse(new CompilerOperationError("model_output_invalid"));
      }
      assertEveryVectorValid(output, this.models.embedding.dimensions);
      return output.map((vector) => Array.from(vector));
    } catch (error) {
      return this.refuse(error);
    }
  }

  /** The two retrieval legs share the question's single embedding. */
  private embeddingBatch(inputs: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    this.check();
    if (this.kind === "compile") {
      if (inputType !== "document" || inputs.length < 1 || inputs.length > this.models.embeddingBatchSize) {
        return this.refuse(new CompilerOperationError("unsupported_purpose"));
      }
      return this.embed({ purpose: "compile.embed-documents", inputs });
    }
    if (inputType !== "query" || inputs.length !== 1) {
      return this.refuse(new CompilerOperationError("unsupported_purpose"));
    }
    return this.questionEmbedding(inputs);
  }

  /** Reuse the single pinned question vector within this operation. */
  private questionEmbedding(inputs: string[]): Promise<number[][]> {
    this.question ??= { text: inputs[0], vector: this.embed({ purpose: "query.embed-question", inputs }) };
    if (this.question.text !== inputs[0]) this.refuse(new CompilerOperationError("unsupported_purpose"));
    return this.question.vector;
  }

  /** Adapt the shared embedding code without furnishing any ambient chat methods. */
  // Accessed through compilerModelScope() by the embedding provider factory.
  // fallow-ignore-next-line unused-class-member
  embeddingProvider(): LLMProvider {
    const refuse = async () => this.refuse(new CompilerOperationError("unsupported_call_kind"));
    const embedBatch = (inputs: string[], inputType: EmbeddingInputType = "document") => this.embeddingBatch(inputs, inputType);
    return {
      complete: refuse,
      stream: refuse,
      toolCall: refuse,
      embedBatch,
      embed: async (text, inputType) => (await embedBatch([text], inputType))[0],
    };
  }
}
