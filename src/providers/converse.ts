/**
 * Bearer-authenticated Converse generation through an explicitly selected endpoint.
 * Uses the AWS protocol SDK for request and event-stream handling, without AWS
 * credential discovery or implicit endpoint selection. Embeddings stay separate.
 */
import type { BedrockRuntimeServiceException, ConverseCommandInput, ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import type { LLMMessage, LLMProvider, LLMTool } from "../utils/provider.js";

const REQUEST_TIMEOUT_MS = 600_000;
/** Node timers overflow above this and fire at once, aborting every request. */
const MAX_TIMER_MS = 2_147_483_647;
const BEARER_AUTH_SCHEME = "smithy.api#httpBearerAuth";

/** Configuration for an explicit Converse route; all values are required. */
export interface ConverseSettings {
  model: string;
  baseURL: string;
  apiKey: string;
  requestTimeoutMs: number;
  toolChoice: "any" | "auto";
}

/** Resolve the explicitly selected model without reading credentials. */
export function resolveConverseModel(): string {
  return requiredSetting("LLMWIKI_MODEL");
}

/** Read required settings without falling back to another model or credential. */
export function resolveConverseSettings(): ConverseSettings {
  return {
    model: resolveConverseModel(),
    baseURL: validateEndpoint(requiredSetting("LLMWIKI_CONVERSE_BASE_URL")),
    apiKey: requiredSetting("LLMWIKI_CONVERSE_API_KEY"),
    requestTimeoutMs: resolveRequestTimeout(),
    toolChoice: resolveToolChoice(),
  };
}

/** Converse text and structured generation; this provider never creates embeddings. */
export class ConverseProvider implements LLMProvider {
  private runtime?: ReturnType<typeof createConverseRuntime>;

  constructor(private readonly settings: ConverseSettings) {}

  /** Complete using Converse's canonical messages and explicit token budget. */
  async complete(system: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
    const { client, sdk, failRequest } = await this.getRuntime();
    const command = new sdk.ConverseCommand(this.requestBody(system, messages, maxTokens));
    const response = await client.send(command, this.requestOptions()).catch(failRequest);
    requireFinished(response.stopReason);
    return requireText(response.output?.message?.content?.map((block) => block.text ?? "").join("") ?? "");
  }

  /** Decode the native event stream and forward each text delta to the caller. */
  async stream(system: string, messages: LLMMessage[], maxTokens: number, onToken?: (text: string) => void): Promise<string> {
    const { client, sdk, failRequest } = await this.getRuntime();
    const command = new sdk.ConverseStreamCommand(this.requestBody(system, messages, maxTokens));
    const response = await client.send(command, this.requestOptions()).catch(failRequest);
    let text = "";
    let stopReason: string | undefined;
    try {
      for await (const event of response.stream ?? []) {
        if (Object.keys(event).some((key) => key.endsWith("Exception") || key === "$unknown")) {
          throw new Error("Converse stream failed");
        }
        if (event.messageStop) stopReason = event.messageStop.stopReason;
        const delta = event.contentBlockDelta?.delta?.text;
        if (delta) {
          text += delta;
          onToken?.(delta);
        }
      }
    } catch (error) {
      failRequest(error);
    }
    requireFinished(stopReason);
    return requireText(text);
  }

  /** Return the requested structured tool input as the compiler's JSON payload. */
  async toolCall(system: string, messages: LLMMessage[], tools: LLMTool[], maxTokens: number): Promise<string> {
    const { client, sdk, failRequest } = await this.getRuntime();
    const response = await client.send(new sdk.ConverseCommand({
      ...this.requestBody(system, messages, maxTokens),
      toolConfig: {
        tools: tools.map((tool) => ({ toolSpec: {
          name: tool.name, description: tool.description,
          inputSchema: { json: tool.input_schema } as ToolInputSchema,
        } })),
        toolChoice: this.settings.toolChoice === "auto" ? { auto: {} } : { any: {} },
      },
    }), this.requestOptions()).catch(failRequest);
    requireFinished(response.stopReason, true);
    const tool = response.output?.message?.content?.find((block) => block.toolUse)?.toolUse;
    if (!tool || tool.input === undefined || !tools.some((candidate) => candidate.name === tool.name)) {
      throw new Error("Converse response did not contain a requested tool call");
    }
    return JSON.stringify(tool.input);
  }

  /** Require a separately configured embedding provider. */
  async embed(_text: string): Promise<number[]> {
    throw new Error("Converse does not serve embeddings; set LLMWIKI_EMBEDDING_PROVIDER or disable embeddings");
  }

  /** Load optional dependencies on first use and share initialization across calls. */
  private getRuntime(): ReturnType<typeof createConverseRuntime> {
    return this.runtime ??= createConverseRuntime(this.settings);
  }

  /** Bound the complete request, including consumption of a streamed body. */
  private requestOptions(): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(this.settings.requestTimeoutMs) };
  }

  /** Share canonical messages and inference settings across all Converse operations. */
  private requestBody(system: string, messages: LLMMessage[], maxTokens: number): ConverseCommandInput {
    return {
      modelId: this.settings.model,
      system: [{ text: system }],
      messages: messages.map(({ role, content }) => ({ role, content: [{ text: content }] })),
      inferenceConfig: { maxTokens },
    };
  }
}

/** Import the protocol libraries only when a Converse request needs them. */
async function loadConverseDependencies() {
  try {
    return await Promise.all([
      import("@aws-sdk/client-bedrock-runtime"),
      import("@smithy/node-http-handler"),
    ]);
  } catch {
    throw Object.assign(new Error(
      "Converse requires optional packages. Install them alongside llmwiki: " +
      "npm install @aws-sdk/client-bedrock-runtime @smithy/node-http-handler",
    ), { nonRetryable: true });
  }
}

/** Initialize the bearer-only transport after its optional libraries are available. */
async function createConverseRuntime(settings: ConverseSettings) {
  const [sdk, { NodeHttpHandler }] = await loadConverseDependencies();
  const client = new sdk.BedrockRuntimeClient({
    region: "converse-gateway",
    endpoint: settings.baseURL,
    token: { token: settings.apiKey },
    httpAuthSchemeProvider: () => [{ schemeId: BEARER_AUTH_SCHEME }],
    maxAttempts: 1,
    // The Bedrock client defaults to HTTP/2; gateways commonly speak HTTP/1.1 only.
    requestHandler: new NodeHttpHandler(),
  });
  return { client, sdk, failRequest: (error: unknown): never => failConverseRequest(error, sdk.BedrockRuntimeServiceException) };
}

/** Read one nonblank value at the environment boundary. */
function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the converse provider`);
  return value;
}

/** Report transport status without copying a service message that may contain input. */
function failConverseRequest(error: unknown, ServiceException: typeof BedrockRuntimeServiceException): never {
  const status = error instanceof ServiceException ? error.$metadata.httpStatusCode : undefined;
  if (status) {
    throw Object.assign(new Error(`Converse request failed (HTTP ${status})`), {
      nonRetryable: status >= 400 && status < 500 && status !== 429,
    });
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    throw new Error("Converse request timed out");
  }
  throw new Error("Converse request failed (transport or invalid response)");
}

/** Reject truncated, blocked, or unfinished outputs before they can become pages. */
function requireFinished(stopReason: string | undefined, toolCall = false): void {
  const finished = toolCall ? stopReason === "tool_use" : stopReason === "end_turn" || stopReason === "stop_sequence";
  if (!finished) throw new Error("Converse generation did not finish; output discarded");
}

/** Refuse a successful protocol envelope that contains no generated text. */
function requireText(text: string): string {
  if (!text.trim()) throw new Error("Converse response contained no text");
  return text;
}

/** Validate endpoint shape without reflecting credentials in an error message. */
function validateEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid endpoint");
    }
    return value.replace(/\/$/, "");
  } catch {
    throw new Error("LLMWIKI_CONVERSE_BASE_URL must be an HTTP(S) endpoint without credentials, query, or fragment");
  }
}

/** Read the shared request deadline, rejecting values a timer cannot honour. */
function resolveRequestTimeout(): number {
  const raw = process.env.LLMWIKI_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return REQUEST_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`LLMWIKI_REQUEST_TIMEOUT_MS must be an integer from 1 to ${MAX_TIMER_MS}`);
  }
  return value;
}

/**
 * Allow endpoints that accept tools but reject forced selection, still requiring
 * a tool response. Needed in practice: Sonnet behind a Bedrock gateway returned
 * HTTP 400 for `any` and compiled successfully with `auto`.
 */
function resolveToolChoice(): "any" | "auto" {
  const value = process.env.LLMWIKI_CONVERSE_TOOL_CHOICE?.trim() || "any";
  if (value !== "any" && value !== "auto") throw new Error("LLMWIKI_CONVERSE_TOOL_CHOICE must be any or auto");
  return value;
}
