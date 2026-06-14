import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { collectExportPages } from "../src/export/collect.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const WITH_XOKF =
  '---\ntitle: Cust\nx-okf:\n  type: "BigQuery Table"\n  originalFrontmatter:\n    type: "BigQuery Table"\n    vendorKey: 7\n---\n\nA table.\n';
const WITHOUT_XOKF = "---\ntitle: Plain\n---\n\nPlain page.\n";

describe("collectExportPages reads x-okf snapshot", () => {
  it("surfaces xOkf on imported pages and leaves native pages undefined", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-rx-collect-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/cust.md"), WITH_XOKF);
    await writeFile(path.join(dir, "wiki/concepts/plain.md"), WITHOUT_XOKF);
    const pages = await collectExportPages(dir);
    const cust = pages.find((p) => p.slug === "cust")!;
    const plain = pages.find((p) => p.slug === "plain")!;
    expect(cust.xOkf?.type).toBe("BigQuery Table");
    expect(cust.xOkf?.originalFrontmatter.vendorKey).toBe(7);
    expect(plain.xOkf).toBeUndefined();
  });
});
