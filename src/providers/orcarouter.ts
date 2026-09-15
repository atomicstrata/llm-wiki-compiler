/**
 * OrcaRouter LLM provider implementation.
 *
 * Extends OpenAIProvider since OrcaRouter exposes an OpenAI-compatible API.
 * Chat and embeddings share the gateway endpoint and credential; embedding
 * model ids retain their provider namespace.
 */

import { OpenAIProvider } from "./openai.js";
import { EMBEDDING_MODELS } from "../utils/constants.js";

/** OrcaRouter API base URL. */
const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/** OrcaRouter-backed LLM provider using the OpenAI-compatible endpoint. */
export class OrcaRouterProvider extends OpenAIProvider {
  constructor(model: string, apiKey: string, embeddingModel = EMBEDDING_MODELS.orcarouter) {
    super(model, { baseURL: ORCAROUTER_BASE_URL, apiKey, embeddingModel });
  }
}
