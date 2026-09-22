/**
 * @file test/products/cli-provider-invocation.test.ts
 * @description The CLI's opt-in provider backend: an operator names a module,
 * and the bundled CLI runs provider phases through it.
 *
 * THE CLI BUNDLES NO BACKEND, and that stays true here — what it gains is a
 * documented way for an operator to point at THEIR OWN module. Nothing in core
 * imports a specific backend, so a product package still cannot choose what
 * executes on the machine.
 *
 * ABSENT IS A REAL ANSWER AND IS ASSERTED, because "the CLI cannot run
 * providers" was the state this closes, and a change that made the loader fire
 * unconditionally would be worse than the gap it fixes.
 *
 * The refusals are as load-bearing as the success: a module exporting the wrong
 * thing is refused by NAME rather than surfacing later as a provider phase that
 * inexplicably declines, which is exactly how long the earlier gaps survived.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliProviderInvocation } from "../../src/commands/product/host.js";

const ENV = "LLMWIKI_PROVIDER_INVOCATION_MODULE";

afterEach(() => { delete process.env[ENV]; });

/** Write one operator module and point the environment at it. */
async function configureModule(source: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "cli-provider-module-"));
  const file = path.join(dir, "invocation.mjs");
  await writeFile(file, source, "utf8");
  process.env[ENV] = file;
}

describe("the CLI's opt-in provider invocation", () => {
  it("is ABSENT when the operator configured no module", async () => {
    expect(await cliProviderInvocation()).toBeUndefined();
  });

  it("LOADS the operator's module and returns its invocation", async () => {
    await configureModule(`
      export function createProviderInvocation() {
        return { legInputFor: () => null };
      }
    `);
    const invocation = await cliProviderInvocation();
    expect(typeof invocation?.legInputFor).toBe("function");
  });

  it("accepts a DEFAULT export too, so an operator need not learn a name", async () => {
    await configureModule(`export default () => ({ legInputFor: () => null });`);
    expect(typeof (await cliProviderInvocation())?.legInputFor).toBe("function");
  });

  it("REFUSES a module that exports no factory", async () => {
    await configureModule(`export const somethingElse = 1;`);
    await expect(cliProviderInvocation()).rejects.toThrow(/must export createProviderInvocation/);
  });

  it("REFUSES a factory returning something that is not an invocation", async () => {
    // Checked rather than assumed: the wrong shape would otherwise surface much
    // later as a provider phase that refuses for no stated reason.
    await configureModule(`export default () => ({ notALeg: true });`);
    await expect(cliProviderInvocation()).rejects.toThrow(/no provider invocation/);
  });
});
