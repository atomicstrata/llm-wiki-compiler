/**
 * @file src/capability-providers/host/index.ts
 * @description The supported surface for HOSTING capability providers.
 *
 * These are the constructors an operator's provider module imports: install a
 * provider they wrote, learn the pin their pack must name, issue the grant it
 * runs under, and build the invocation the runtime routes provider phases to.
 * They ship in the distributed package, because a module an operator has to
 * write is useless if the pieces it needs are only in a source checkout.
 *
 * THE BACKEND IS NOT HERE. Everything in this directory arranges an invocation;
 * nothing launches a process. See {@link ProviderHostBackendV1} for the contract
 * the operator implements, and why the platform ships no implementation of it.
 */

export {
  DEV_PROVIDER_BOUNDS, devEffectiveGrantRequest, devGrantScope, devModelInvokeAuthority, devSourceReadAuthority, issueDevProviderGrant,
} from "./grant.js";
export type {
  DevGrantRequestContextV1, IssueDevGrantRequestV1, IssuedDevGrantV1,
} from "./grant.js";
export { derivePinForPayload, installDevProvider } from "./install.js";
export type { InstallDevProviderRequestV1, InstalledDevProviderV1 } from "./install.js";
export { devProviderInvocation } from "./invocation.js";
export type { DevInvocationHostV1 } from "./invocation.js";
export type {
  ProviderBackendChannelV1, ProviderHostBackendV1, ProviderLaunchDescriptorV1,
} from "./backend-contract.js";
