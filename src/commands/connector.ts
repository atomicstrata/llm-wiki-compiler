/**
 * @file src/commands/connector.ts
 * @description CLI actions for first-party connector discovery and execution.
 *
 * Connectors are compiled-in modules activated by the operator through
 * `LLMWIKI_CONNECTORS`. This command surface never grants live-write authority:
 * `connector run` delegates to the substrate, which stages connector output as
 * review candidates and applies the same typed floor as other ingestion paths.
 */

import { discoverableConnectors } from "../connectors/registry.js";
import { isConnectorActivated } from "../connectors/config.js";
import { runConnector } from "../connectors/run.js";
import { captureConnectorResult } from "../connectors/candidate-batch.js";
import {
  renderCandidateIds,
  renderConnectorReason,
} from "../connectors/candidate-display.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import * as output from "../utils/output.js";
import type { ConnectorDef } from "../connectors/types.js";

/** Test seams for bounded command-result rendering. */
export interface ConnectorCommandDeps {
  runner?: typeof runConnector;
}

/** Parsed `connector run` options. */
export interface ConnectorRunOptions {
  input?: string[];
}

/** Parse `--input key=value` pairs into the substrate input object. */
function parseInputs(pairs: readonly string[] = []): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error(`--input must be key=value, got ${JSON.stringify(pair)}`);
    inputs[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return inputs;
}

/** Human-readable activation/binding state for one connector row. */
function connectorState(id: string, bindings: Record<string, unknown>): string {
  const activation = isConnectorActivated(id) ? "activated" : "inactive";
  const binding = bindings[id] ? "profile-bound" : "unbound";
  return `${activation}, ${binding}`;
}

/** Human-readable connector discovery row. */
function connectorRow(def: ConnectorDef, bindings: Record<string, unknown>): string {
  return `${def.id} ${def.version} ${connectorState(def.id, bindings)} hosts=${def.allowedHosts.join(",")}`;
}

/** Print every user-facing connector with operator activation and profile-binding state. */
export async function connectorListCommand(root = process.cwd()): Promise<void> {
  const loaded = await loadNonDefaultProfile(root);
  const bindings = loaded?.profile.connectors ?? {};
  for (const def of discoverableConnectors()) {
    output.status("i", connectorRow(def, bindings));
  }
}

/** Run one connector through the host-owned substrate and print the staged candidate ids. */
export async function connectorRunCommand(
  id: string,
  options: ConnectorRunOptions,
  root = process.cwd(),
  deps: ConnectorCommandDeps = {},
): Promise<void> {
  const rawResult = await (deps.runner ?? runConnector)(root, id, parseInputs(options.input));
  let result;
  try {
    result = captureConnectorResult(rawResult, "public");
  } catch {
    output.status("!", output.error("connector returned invalid candidate identities"));
    process.exitCode = 1;
    return;
  }
  if (result.kind === "refused" || result.kind === "unavailable") {
    output.status("!", output.error(renderConnectorReason(result.reason)));
    process.exitCode = 1;
    return;
  }
  if (result.kind === "recovery-required") {
    output.status("!", output.error(`recovery-required: ${renderCandidateIds(result.candidateIds, "public")}`));
    process.exitCode = 1;
    return;
  }
  output.status("+", output.success(`${result.kind}: ${renderCandidateIds(result.candidateIds, "public")}`));
}
