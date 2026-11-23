/**
 * @file src/portable/errors.ts
 * @description The typed failures of the portable path.
 *
 * A {@link PortableRefusal} is a known no-effect outcome carrying a code a
 * caller can act on. {@link PortableDenied} is deliberately uninformative: an
 * absent project, an unbound principal and a missing permission are the same
 * failure to the caller, so nothing about what exists leaks. The true reason
 * goes to the host's audit sink, never into the message.
 */

import type { RefusalCode } from "./contracts.js";

/** A known refusal: nothing was written, and the code says why. */
export class PortableRefusal extends Error {
  constructor(readonly code: RefusalCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PortableRefusal";
  }
}

/** Denied, absent or uncleared. The three are indistinguishable by design. */
export class PortableDenied extends Error {
  constructor() {
    super("not found");
    this.name = "PortableDenied";
  }
}

/** A registration or host-configuration problem the operator must fix. */
export class PortableHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableHostError";
  }
}
