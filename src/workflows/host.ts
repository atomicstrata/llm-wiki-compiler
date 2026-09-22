/**
 * Standard CLI, MCP and legacy API host composition. Validate against the
 * engine's resolved core instance, not merely the facade's own core copy, before
 * any operation can perform I/O. Runtime construction is synchronous and passive.
 */
import { createLocalWorkflowHost as createCoreHost } from "@atomicstrata/llmwiki-core/local-workflow-host";
import { createLocalWorkflowRuntime } from "@atomicstrata/llmwiki-local-workflows";

/** Preserve legacy function signatures while enforcing engine/core identity. */
export function createLocalWorkflowHost() {
  const host = createCoreHost();
  createLocalWorkflowRuntime(host);
  return host;
}
