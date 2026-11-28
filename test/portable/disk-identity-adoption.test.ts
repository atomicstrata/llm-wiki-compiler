/**
 * @file test/portable/disk-identity-adoption.test.ts
 * @description The format-2 adoption cases of the CP192 identity/marker repair,
 * moved intact from `disk-identity-durability.test.ts` (CP195), with the same
 * describe and case identities.
 *
 * They pin that adoption skips the replacing writer's exact
 * `<safeId>.json.<16 hex>.tmp` identity sibling, untouched, and still refuses
 * any other unknown regular or nonregular identity entry by name. Each case
 * registers the fixture project under an explicit fixture `controlRoot`; no
 * default host control or operator state is used.
 *
 * STATUS: UNRUN and NOT ADMITTED; this file is NOT part of the store run.
 * Adoption takes the fixture project's real mutation lock. Its owner record
 * first tries a native start-time lookup through `bun:ffi` (refused, and
 * logged, by the test guard) and then falls back to a bounded `ps` start-time
 * lookup (`src/utils/lock-owner.ts`), an application-launched child. The
 * current judge accepts neither event, so these cases stay pending until a
 * separately reviewed decision; the product lock is not altered or stubbed.
 * No model is invoked and no listener is opened. These are AFTER-STATE
 * assertions, not a power-loss witness.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { adoptFormat2 } from "../../src/portable/host/format-adoption.js";
import { registerLocalProject } from "../../src/portable/host/local-control.js";
import { useIdentityFixture } from "./disk-identity-fixture.js";

const NONCE = "0123456789abcdef";

const fixture = useIdentityFixture();

describe("format-2 adoption over identity temp siblings", () => {
  it("adopts past an identity temp sibling and leaves it in place", async () => {
    const controlRoot = path.join(fixture.base, "control");
    await registerLocalProject(fixture.root, controlRoot);
    await writeFile(path.join(await fixture.ledger("identity"), `op_a.json.${NONCE}.tmp`), "partial");
    expect((await adoptFormat2(fixture.root, { controlRoot })).kind).toBe("adopted");
    expect(await readdir(await fixture.ledger("identity"))).toContain(`op_a.json.${NONCE}.tmp`);
  });

  it("refuses an unknown identity entry by name", async () => {
    const controlRoot = path.join(fixture.base, "control");
    await registerLocalProject(fixture.root, controlRoot);
    await writeFile(path.join(await fixture.ledger("identity"), "notes.txt"), "x");
    await expect(adoptFormat2(fixture.root, { controlRoot })).rejects.toThrow("notes.txt");
  });

  it("refuses a nonregular identity entry by name", async () => {
    const controlRoot = path.join(fixture.base, "control");
    await registerLocalProject(fixture.root, controlRoot);
    await mkdir(path.join(await fixture.ledger("identity"), "op_d.json"));
    await expect(adoptFormat2(fixture.root, { controlRoot })).rejects.toThrow("op_d.json");
  });
});
