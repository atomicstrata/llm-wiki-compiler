/**
 * @file test/connectors/connector-command-fixtures.ts
 * @description Shared command-result capture seam for connector terminal tests.
 */

import { vi } from "vitest";
import { connectorRunCommand } from "../../src/commands/connector.js";

/** Run one injected connector result and capture complete physical log writes. */
export async function captureConnectorCommand(
  root: string,
  result: unknown,
): Promise<string[]> {
  const logger = vi.spyOn(console, "log").mockImplementation(() => {});
  const command = connectorRunCommand as unknown as (
    id: string, options: object, root: string, deps: { runner: () => Promise<unknown> },
  ) => Promise<void>;
  await command("fixture", {}, root, { runner: async () => result });
  return logger.mock.calls.map(([line]) => String(line));
}
