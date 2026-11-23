/**
 * @file src/portable/scale/open.ts
 * @description The SDK entry point of the paged protocol: `openPagedProject`,
 * beside `openProject`, which is unchanged.
 *
 * Adoption is NEGOTIATED, never assumed. A caller states the protocols it
 * speaks; only one that states the paged protocol gets a session with a
 * `paged` member, and a hosted call carries that statement on every request.
 * The version 1 session inside it is exactly what `openProject` returns.
 *
 * A session that did not negotiate has no `paged` member. {@link pagedOf}
 * gives a surface one answer for it: a refusal naming the missing protocol,
 * never a silent fall back to collecting version 1's array listing.
 */

import { ACCESS_NOTICE } from "../contracts.js";
import { openProject, type OpenProjectOptions } from "../index.js";
import { openLocalRuntime } from "../local.js";
import type { ProjectSession } from "../project/api.js";
import { createProjectSession } from "../project/wiki-project.js";
import {
  SCALE_PROTOCOL_V2, type PagedProjectSessionV2, type PagedProjectV2, type PagedRefusedV2,
} from "./contracts.js";
import { createPagedProject } from "./paged-reads.js";
import { remotePagedProject } from "./remote-paged.js";

/** What `openPagedProject` needs: how to open the project, and the protocols the caller speaks. */
export interface OpenPagedProjectOptions extends OpenProjectOptions {
  /** Must include `portable-scale/2`. Nothing is inferred from its absence. */
  protocols: readonly string[];
}

const NOT_NEGOTIATED: PagedRefusedV2 = {
  kind: "refused", code: "capability_unsupported", capability: "protocol:portable-scale/2", notice: ACCESS_NOTICE,
};

/** The paged project of a session that never negotiated: every method refuses by name. */
const UNNEGOTIATED: PagedProjectV2 = {
  protocol: SCALE_PROTOCOL_V2,
  negotiate: async () => NOT_NEGOTIATED,
  pages: { listPage: async () => NOT_NEGOTIATED, open: async () => NOT_NEGOTIATED },
  search: async () => NOT_NEGOTIATED,
};

/** The paged reads a session negotiated, or the refusing stand-in when it negotiated none. */
export function pagedOf(session: ProjectSession): PagedProjectV2 {
  return "paged" in session ? (session as PagedProjectSessionV2).paged : UNNEGOTIATED;
}

/**
 * Open a portable project session that also speaks the paged protocol.
 *
 * @throws TypeError when the caller does not state `portable-scale/2`.
 * @throws PortableDenied exactly as `openProject` does.
 */
export async function openPagedProject(options: OpenPagedProjectOptions): Promise<PagedProjectSessionV2> {
  if (!options.protocols.includes(SCALE_PROTOCOL_V2)) {
    throw new TypeError(`openPagedProject requires the caller to state the ${SCALE_PROTOCOL_V2} protocol`);
  }
  const { project, credential } = options;
  if ("localRoot" in project) {
    if (credential.kind !== "local-os") throw new TypeError("a local project is opened with the local-os credential");
    const runtime = await openLocalRuntime(project.localRoot, { model: options.localHostModel });
    return { ...createProjectSession(runtime), paged: createPagedProject(runtime) };
  }
  const session = await openProject(options);
  if (credential.kind === "local-os") throw new TypeError("a hosted project needs a host or service token");
  const token = credential.kind === "host-token" ? credential.token : credential.serviceToken;
  return { ...session, paged: remotePagedProject({ host: project.host, project: project.project, token }) };
}
