/**
 * @file Generic CLI composition regression: invoking and resuming forward the
 * operator-selected provider adapter; read-only preview never loads it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { productInvokeCommand, productPreviewCommand, productResumeCommand } from "../../src/commands/product/action.js";
import { cliProductService, cliProviderInvocation } from "../../src/commands/product/host.js";

vi.mock("../../src/commands/product/host.js", () => ({
  cliProductService: vi.fn(), cliProviderInvocation: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it("passes the selected adapter to invoke and resume, but not preview", async () => {
  const adapter = { adapter: "operator-selected" };
  const refused = { status: "refused", reason: "fixture refusal" };
  const invoke = vi.fn().mockResolvedValue(refused);
  const resume = vi.fn().mockResolvedValue(refused);
  const preview = vi.fn().mockResolvedValue(refused);
  vi.mocked(cliProductService).mockReturnValue({ invoke, resume, preview } as never);
  vi.mocked(cliProviderInvocation).mockResolvedValue(adapter as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await productInvokeCommand("/fixture", "generic.action", { json: true });
  await productResumeCommand("/fixture", "run-fixture", "generic.action", { json: true });
  expect(cliProductService).toHaveBeenNthCalledWith(1, "/fixture", ["preparation.run"], adapter);
  expect(cliProductService).toHaveBeenNthCalledWith(2, "/fixture", ["preparation.run"], adapter);
  await productPreviewCommand("/fixture", "generic.action", { json: true });
  expect(cliProductService).toHaveBeenNthCalledWith(3, "/fixture", []);
  expect(cliProviderInvocation).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledOnce();
  expect(preview).toHaveBeenCalledOnce();
});
