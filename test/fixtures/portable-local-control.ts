/**
 * @file test/fixtures/portable-local-control.ts
 * @description Test support: project registration for the gate witnesses,
 * which need the registered state that `src/portable/host/pending-gate.ts`
 * reads.
 *
 * The public baseline shipped no way to register a project, so this fixture
 * carried its own copy of the local host's control plane. The scaling
 * candidate ships that control plane as `src/portable/host/local-control.ts`
 * (used by `llmwiki init --expected-size` and `scale`), and the copy had
 * become a duplicate of it: identical in every line it had, the shipped
 * module only adding members. The fixture now forwards to the one real
 * implementation, so the witnesses register a project exactly as the
 * product does.
 */

export { registerLocalProject, type RegistrationResult } from "../../src/portable/host/local-control.js";
