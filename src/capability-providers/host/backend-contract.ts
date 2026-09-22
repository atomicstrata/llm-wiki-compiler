/**
 * @file src/capability-providers/host/backend-contract.ts
 * @description The backend contract an operator implements to run providers.
 *
 * IT IS THE RUNTIME'S OWN CONTRACT, RE-EXPORTED — never a second declaration of
 * it. A public restatement drifts from the real one the moment either moves, and
 * the drift hides behind whatever cast connects them: the first version of this
 * file omitted `expectedIdentity` and weakened the input tokens to `unknown[]`,
 * so a backend written against it would have compiled and then been handed
 * fields it had no types for.
 *
 * LLMWIKI SHIPS THE CONTRACT, NOT AN IMPLEMENTATION. Launching a provider means
 * executing third-party code, and which sandbox that happens in is the
 * operator's decision — so this states what a backend must do and nothing in the
 * published package does it. A host supplies its own through
 * `LLMWIKI_PROVIDER_INVOCATION_MODULE` or the SDK's `providerInvocation`.
 *
 * WHAT A BACKEND OWES. It launches a process and presents it as a byte
 * transport: `send` writes an already-encoded frame, `receive` returns raw
 * chunks for the runtime's own decoder to split, `outputRoot` names where
 * declared artifacts are collected, and `terminate` stops it. Framing, protocol
 * grammar, sequencing, custody and evidence all stay in the runtime, so a
 * backend cannot reinterpret them.
 */

export type {
  ProviderBackendChannelV1,
  ProviderLaunchDescriptorV1,
  /** The backend an operator supplies; llmwiki provides none. */
  ProviderBackendV1 as ProviderHostBackendV1,
} from "../runtime/invoke.js";
