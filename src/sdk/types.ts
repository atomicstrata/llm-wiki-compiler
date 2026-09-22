/**
 * Standard SDK contract combining knowledge and local workflows.
 * Core-only consumers use WikiCore without requiring the workflow engine.
 */
export type * from "@atomicstrata/llmwiki-core/compiler-sdk";
import type { WikiCore } from "@atomicstrata/llmwiki-core/compiler-sdk";
import type { WikiWorkflow } from "./workflow-types.js";

export interface Wiki extends WikiCore, WikiWorkflow {}
