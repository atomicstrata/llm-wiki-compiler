/**
 * @file Capability-provider backend contract. Kept independent of invocation
 * execution so host backends share the exact launch and transport types.
 */
import type { Sha256Digest } from "../types.js";
import type { PlatformArtifactV1 } from "../packages/protocol.js";
import type { RuntimeExpectedIdentityV1, RuntimeInputTokenDescriptorV1 } from "./types.js";

/** §11 typed payload descriptor for one host-materialized broker-response body. */
export interface PayloadDescriptorV1 {
  readonly token: string;
  readonly digest: Sha256Digest;
  readonly byteCount: number;
  readonly mediaType: string;
  readonly provenanceLabel: string;
}

/** Host-written, guest-read-only region for large broker-response bytes (D6.1). */
export interface BrokerResponseRegionV1 {
  materialize(bytes: readonly Uint8Array[], provenanceLabel: string): Promise<PayloadDescriptorV1>;
}

/** One framed duplex to an accepted, launched provider process. */
export interface ProviderBackendChannelV1 {
  send(frame: Buffer): Promise<void>;
  receive(): Promise<Buffer | null>;
  outputRoot(): Promise<string>;
  terminate(): Promise<void>;
}

/** The installed cache tree the host copies into the invocation-private root. */
export interface LaunchSnapshotInputV1 {
  readonly sourceTreeReal: string;
  readonly artifact: PlatformArtifactV1;
  readonly launchParentDir: string;
}

/**
 * Host-owned launch inputs the accepted backend receives; only the sealed
 * private root, never a project or cache path.
 *
 * Backend-contract requirement (O1/backend boundary): the accepted backend MUST
 * mount the invocation namespace so the provider resolves the sandbox-relative
 * input-token and `brokerResponseRegionMount` paths consistently — inputs and
 * the broker-response region are addressed by relative token/mount, and the
 * host never hands the provider an absolute host path. `launchRoot` is the
 * verified package tree to execute `entrypointRelativePath` from; the inputs
 * mount is read-only and the broker-response region is host-written /
 * guest-read-only.
 */
export interface ProviderLaunchDescriptorV1 {
  readonly expectedIdentity: RuntimeExpectedIdentityV1;
  readonly inputTokens: readonly RuntimeInputTokenDescriptorV1[];
  readonly launchRoot: string;
  readonly entrypointRelativePath: string;
  readonly brokerResponseRegionMount: string;
  readonly wallTimeMs: number;
}

/** The accepted sandbox backend; the concrete launcher lands in Tasks 8/9. */
export interface ProviderBackendV1 {
  launch(descriptor: ProviderLaunchDescriptorV1): Promise<ProviderBackendChannelV1>;
}
