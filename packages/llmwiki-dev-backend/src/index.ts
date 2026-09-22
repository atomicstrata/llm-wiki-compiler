/**
 * @file packages/llmwiki-dev-backend/src/index.ts
 * @description Public surface of the local development provider backend.
 *
 * Read {@link unsandboxedLocalBackend}'s file comment before using this: it runs
 * provider code with your full privileges and no isolation, and it exists so a
 * provider you WROTE can be executed during development. The platform ships no
 * default backend, and this package is never wired in automatically.
 */

export { unsandboxedLocalBackend } from "./backend.js";
export type { UnsandboxedLocalBackendOptionsV1 } from "./backend.js";
// The CONTRACT lives in llmwiki; this package implements it.
export type {
  ProviderBackendChannelV1, ProviderHostBackendV1, ProviderLaunchDescriptorV1,
} from "@atomicstrata/llmwiki-core";

// The HOST constructors now live in llmwiki itself, so an operator writing a
// provider module imports them from the distributed package rather than from
// this development-only one. Re-exported here so existing callers keep working.
export {
  DEV_PROVIDER_BOUNDS, derivePinForPayload, devEffectiveGrantRequest, devGrantScope,
  devProviderInvocation, installDevProvider, issueDevProviderGrant,
} from "@atomicstrata/llmwiki-core";
export type {
  DevInvocationHostV1, InstallDevProviderRequestV1, InstalledDevProviderV1,
  IssueDevGrantRequestV1, IssuedDevGrantV1,
} from "@atomicstrata/llmwiki-core";

// The provider-channel launcher the isolation backend (and any operator backend
// that wraps a child process) builds on; exported so it is imported by package
// name rather than by a checkout-relative path.
export { createDevChannel, launchProviderChannel } from "./channel.js";
export type { DevBackendChannelV1, DevChannelInputV1 } from "./channel.js";
