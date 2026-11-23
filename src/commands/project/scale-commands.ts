/**
 * @file src/commands/project/scale-commands.ts
 * @description The handlers behind `llmwiki project scale …`: the paged reads
 * of slice S1 as commands.
 *
 * Each read opens a session from `--project <ref>`, stating the paged
 * protocol, makes ONE paged read and prints its outcome. A project whose store
 * has no catalog answers `capability_unsupported` by name; nothing here falls
 * back to collecting the version 1 listing. A denial, including a session that
 * can no longer be opened, prints the paged union's `permission_denied`.
 *
 * No fixture demo is registered here: this package ships no simulated host.
 */

import { ACCESS_NOTICE } from "../../portable/contracts.js";
import { PortableDenied } from "../../portable/errors.js";
import type { PagedProjectV2 } from "../../portable/scale/contracts.js";
import { pagedOf } from "../../portable/scale/open.js";
import { openCommandSession, reportCommand, type ProjectRef } from "./session.js";

/** Run one paged read against the project a command names. */
function withPaged(ref: ProjectRef, read: (paged: PagedProjectV2) => Promise<unknown>): Promise<number> {
  return reportCommand(async () => {
    try {
      const session = await openCommandSession(ref);
      try {
        return await read(pagedOf(session));
      } finally {
        await session.close();
      }
    } catch (error) {
      if (error instanceof PortableDenied) return { kind: "refused", code: "permission_denied", notice: ACCESS_NOTICE };
      throw error;
    }
  });
}

/** A numeric option as a number, or `undefined` when it was not given. */
function numberOption(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/** `project scale capabilities`: what the project's store declares at scale. */
export function projectScaleCapabilitiesCommand(ref: ProjectRef): Promise<number> {
  return withPaged(ref, (paged) => paged.negotiate());
}

/** `project scale pages`: one listing page; pass the printed cursor back for the next. */
export function projectScalePagesCommand(options: ProjectRef & { cursor?: string; limit?: string }): Promise<number> {
  return withPaged(options, (paged) => paged.pages.listPage({ cursor: options.cursor, limit: numberOption(options.limit) }));
}

/** `project scale open <id>`: one page, the only paged read that touches a body. */
export function projectScaleOpenCommand(id: string, ref: ProjectRef): Promise<number> {
  return withPaged(ref, (paged) => paged.pages.open(id));
}

/** `project scale search <query>`: bounded keyword search that says when its budget cut it short. */
export function projectScaleSearchCommand(query: string, options: ProjectRef & { limit?: string }): Promise<number> {
  return withPaged(options, (paged) => paged.search({ text: query, limit: numberOption(options.limit) }));
}
