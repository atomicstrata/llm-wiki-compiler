/**
 * @file src/portable/scoped/unsupported.ts
 * @description The scoped surface of a project whose store cannot offer the
 * scoped path: every write refuses `capability_unsupported` naming scope
 * fences, and every read shows nothing. Pure data and replies: it opens no
 * store and imports no host implementation, so a client (and a local
 * directory, which has no scope fences) can answer with it.
 */

import { ACCESS_NOTICE } from "../contracts.js";
import { SCOPE_FENCES_CAPABILITY, SCOPED_PROTOCOL_V2, type ScopedProjectV2, type ScopedUnsupportedV2 } from "./contracts.js";

/** The one refusal a store without authority-maintained scope fences gives. */
const SCOPED_UNSUPPORTED: ScopedUnsupportedV2 = {
  kind: "refused", code: "capability_unsupported", capability: SCOPE_FENCES_CAPABILITY, notice: ACCESS_NOTICE,
};

/** Every method of a project whose store cannot offer the scoped path: writes refuse by name, reads show nothing. */
export const UNSUPPORTED_PROJECT: ScopedProjectV2 = {
  protocol: SCOPED_PROTOCOL_V2,
  negotiate: async () => SCOPED_UNSUPPORTED,
  propose: async () => SCOPED_UNSUPPORTED,
  coverage: async () => ({ visible: false }),
  candidates: {
    list: async () => ({ items: [], notice: ACCESS_NOTICE }),
    get: async () => ({ visible: false }),
    approve: async () => SCOPED_UNSUPPORTED,
  },
  apply: async () => SCOPED_UNSUPPORTED,
  sourceStatus: async () => ({ visible: false }),
  view: async () => ({ visible: false }),
};
