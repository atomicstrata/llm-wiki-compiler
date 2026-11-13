/**
 * Image ingestion module using LLM vision capabilities.
 *
 * Reads a local image file, encodes it as base64, and sends it to the
 * configured LLM provider's vision endpoint for OCR-plus-description
 * extraction. Requires the active provider to support image content blocks
 * (currently: Anthropic).
 *
 * Throws a clear error when the provider does not support vision, rather
 * than falling back silently.
 */

import { readFile } from "fs/promises";
import path from "path";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicClientOptions } from "../providers/anthropic.js";
import { IMAGE_DESCRIBE_MAX_TOKENS } from "../utils/constants.js";
import { resolveAnthropicAuthFromEnv, resolveAnthropicBaseURLFromEnv, resolveAnthropicModelFromEnv } from "../utils/claude-settings.js";
import { PROVIDER_MODELS } from "../utils/constants.js";
import { titleFromFilename, type IngestedSource } from "./shared.js";

/** Mime types supported by Anthropic vision. */
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const EXTENSION_TO_MIME: Record<string, AnthropicImageMediaType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Return the MIME type for an image file, or throw on unknown extension. */
function mimeTypeForExtension(ext: string): AnthropicImageMediaType {
  const mimeType = EXTENSION_TO_MIME[ext.toLowerCase()];
  if (!mimeType) {
    throw new Error(
      `Unsupported image extension "${ext}". Supported: ${Object.keys(EXTENSION_TO_MIME).join(", ")}`,
    );
  }
  return mimeType;
}

/**
 * Build an Anthropic client from the current environment config. The SDK is
 * loaded here so that only an image ingest pays for it.
 */
async function buildClient(): Promise<Anthropic> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const baseURL = resolveAnthropicBaseURLFromEnv();
  const auth = resolveAnthropicAuthFromEnv();
  return new Anthropic(buildAnthropicClientOptions({ baseURL, ...auth }));
}

/** Send an image to Anthropic vision and return the extracted description. */
async function describeImageWithVision(
  client: Anthropic,
  model: string,
  imageData: string,
  mimeType: AnthropicImageMediaType,
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: IMAGE_DESCRIBE_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType, data: imageData },
          },
          {
            type: "text",
            text: "Extract and transcribe all text visible in this image. Then provide a detailed description of any non-text visual content. Format your response as markdown.",
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.type === "text" ? textBlock.text : "";
}

/**
 * Ingest a local image file using LLM vision for OCR and description.
 *
 * Only Anthropic is supported for vision. The active provider must be
 * Anthropic; if not, a clear error is thrown rather than degrading silently.
 *
 * @param filePath - Absolute or relative path to an image file.
 * @returns An object with a title derived from the filename and the extracted content.
 * @throws When the provider does not support vision or on read/API failure.
 */
export default async function ingestImage(filePath: string): Promise<IngestedSource> {
  const providerName = process.env.LLMWIKI_PROVIDER ?? "anthropic";

  if (providerName !== "anthropic") {
    throw new Error(
      `Image ingest requires the Anthropic provider (vision). ` +
        `Current provider: "${providerName}". ` +
        `Set LLMWIKI_PROVIDER=anthropic and ANTHROPIC_API_KEY to use image ingest.`,
    );
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = mimeTypeForExtension(ext);
  const imageBuffer = await readFile(filePath);
  const imageData = imageBuffer.toString("base64");

  const client = await buildClient();
  const model = resolveAnthropicModelFromEnv() ?? PROVIDER_MODELS.anthropic;
  const content = await describeImageWithVision(client, model, imageData, mimeType);
  const title = titleFromFilename(filePath);

  return { title, content };
}
