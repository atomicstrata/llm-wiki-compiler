/**
 * @file test/products/active-binding.test.ts
 * @description The active-binding parser fails closed on a missing field,
 * malformed JSON, or a malformed component digest, and round-trips a well-formed
 * binding (with and without the optional detached certificate). The store read
 * classifies an absent leaf as `absent` (the legacy signal), a symlinked or
 * corrupt leaf as `malformed` (never legacy), and a healthy leaf as `present`; the
 * durable write then reads back byte-for-byte.
 */

import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { parseActiveProductBinding } from "../../src/products/binding/parse.js";
import { ProductBindingError } from "../../src/products/binding/problems.js";
import {
  activeProductBindingPath, readActiveProductBinding, writeActiveProductBinding,
} from "../../src/products/binding/store.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import { bindingFor, buildActivatableProduct, serializeBinding } from "./binding-fixture.js";

const root = useTempRoot();
const manifest = () => buildActivatableProduct().manifest;

/** Write raw bytes to `.llmwiki/active-product.json`. */
async function writeLeaf(text: string): Promise<string> {
  const file = activeProductBindingPath(root.dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

describe("parseActiveProductBinding", () => {
  it("round-trips a well-formed binding", () => {
    const binding = bindingFor(manifest());
    expect(parseActiveProductBinding(serializeBinding(binding))).toEqual(binding);
  });

  it("accepts an optional detached parity certificate digest", () => {
    const binding = bindingFor(manifest(), { parityCertificateDigest: `sha256:${"a".repeat(64)}` as Sha256Digest });
    expect(parseActiveProductBinding(serializeBinding(binding)).parityCertificateDigest).toBe(binding.parityCertificateDigest);
  });

  it("rejects a binding missing a required field", () => {
    const raw = JSON.parse(serializeBinding(bindingFor(manifest())));
    delete raw.packageDigest;
    expect(() => parseActiveProductBinding(JSON.stringify(raw))).toThrow(ProductBindingError);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseActiveProductBinding("{ not json")).toThrow(ProductBindingError);
  });

  it("rejects a malformed component digest", () => {
    const binding = bindingFor(manifest(), { packageDigest: "not-a-digest" as Sha256Digest });
    expect(() => parseActiveProductBinding(serializeBinding(binding))).toThrow();
  });
});

describe("readActiveProductBinding", () => {
  it("classifies an absent binding as absent (the legacy signal)", async () => {
    expect((await readActiveProductBinding(root.dir)).kind).toBe("absent");
  });

  it("classifies a healthy binding as present", async () => {
    await writeLeaf(serializeBinding(bindingFor(manifest())));
    expect((await readActiveProductBinding(root.dir)).kind).toBe("present");
  });

  it("classifies a symlinked leaf as malformed, never legacy", async () => {
    await writeFile(path.join(root.dir, "outside.json"), "{}", "utf8");
    const file = activeProductBindingPath(root.dir);
    await mkdir(path.dirname(file), { recursive: true });
    await symlink(path.join(root.dir, "outside.json"), file);
    expect((await readActiveProductBinding(root.dir)).kind).toBe("malformed");
  });

  it("classifies corrupt bytes as malformed", async () => {
    await writeLeaf("{ not a binding }");
    expect((await readActiveProductBinding(root.dir)).kind).toBe("malformed");
  });
});

describe("writeActiveProductBinding", () => {
  it("durably writes and reads back the same binding", async () => {
    const binding = bindingFor(manifest());
    await writeActiveProductBinding(root.dir, binding);
    const read = await readActiveProductBinding(root.dir);
    expect(read).toEqual({ kind: "present", binding });
  });

  it("replaces an existing binding in place", async () => {
    await writeLeaf(serializeBinding(bindingFor(manifest(), { productVersion: "0.0.1" })));
    const next = bindingFor(manifest());
    await writeActiveProductBinding(root.dir, next);
    const read = await readActiveProductBinding(root.dir);
    expect(read.kind === "present" && read.binding.productVersion).toBe("1.0.0");
  });
});
