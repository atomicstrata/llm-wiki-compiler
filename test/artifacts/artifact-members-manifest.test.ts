/**
 * @file test/artifacts/artifact-members-manifest.test.ts
 * @description W1 manifest-schema + name-policy witnesses, enforced IDENTICALLY
 * at write (the plan denies) and at read (a planted manifest reads
 * artifact-schema-invalid — the mutant is a write-only check a hand-planted
 * bundle would sail past): count/per-member/total ceilings, sorted-unique
 * entries, exactly-three-keys rows, reserved names, the extension allowlist,
 * required names, exactNames, and the overflow-checked total. Profile LOAD
 * validation closes the declaration side: members is json-only and exclusive
 * with metadata, ceilings sit inside the hard caps, and requiredNames must be
 * acceptable members themselves.
 */
import { describe, expect, it, afterEach } from "vitest";
import { validateProfile, ProfileValidationError } from "../../src/profile/validate.js";
import { validateMemberManifestBody } from "../../src/artifacts/members.js";
import type { ArtifactTypeDef, ProfilePack } from "../../src/profile/types.js";
import {
  makeMembersRoot, writeBundle, resolveBundle, plantBundleBody, twoMembers, membersBlock, shaOf,
  BUNDLE_TYPE, BUNDLE_FILE,
} from "../fixtures/member-artifact-root.js";

afterEach(() => { delete process.env.LLMWIKI_TRUSTED_WRITE; });

const bytes = (text: string) => Buffer.from(text, "utf8");
const row = (fileName: string, content = "x") => ({ fileName, sha256: shaOf(bytes(content)), bytes: content.length });

describe("write-side manifest/policy refusals (the plan denies, nothing lands)", () => {
  it("REFUSES over maxCount, over maxMemberBytes, over maxTotalBytes, a disallowed extension, and a reserved name", async () => {
    const root = await makeMembersRoot("members-deny", membersBlock({ maxCount: 2, maxMemberBytes: 8, maxTotalBytes: 12 }));
    const cases: Array<[Parameters<typeof writeBundle>[1], RegExp]> = [
      [[{ fileName: "a.tex", bytes: bytes("1") }, { fileName: "b.tex", bytes: bytes("1") }, { fileName: "c.tex", bytes: bytes("1") }], /maxCount/],
      [[{ fileName: "a.tex", bytes: bytes("123456789") }], /maxMemberBytes/],
      [[{ fileName: "a.tex", bytes: bytes("1234567") }, { fileName: "b.tex", bytes: bytes("1234567") }], /maxTotalBytes/],
      [[{ fileName: "a.pdf", bytes: bytes("1") }], /extension outside/],
      [[{ fileName: BUNDLE_FILE, bytes: bytes("1") }], /reserved|extension/],
    ];
    for (const [files, message] of cases) await expect(writeBundle(root, files), String(message)).rejects.toThrow(message);
  });

  it("REFUSES a missing required name and (under exactNames) an extra one", async () => {
    const root = await makeMembersRoot("members-policy",
      membersBlock({ requiredNames: ["main.tex"], exactNames: true }));
    await expect(writeBundle(root, [{ fileName: "other.tex", bytes: bytes("1") }])).rejects.toThrow(/required member "main.tex" is missing/);
    await expect(writeBundle(root, [{ fileName: "main.tex", bytes: bytes("1") }, { fileName: "extra.tex", bytes: bytes("1") }]))
      .rejects.toThrow(/outside the exact required set/);
  });
});

describe("read-side planted manifests (self-consistent sidecar, schema still refuses)", () => {
  it("unsorted, duplicate, unknown-key, reserved-name, and policy-violating rows each read artifact-schema-invalid", async () => {
    const plants = [
      { members: [row("b.tex"), row("a.tex")] },                                    // unsorted
      { members: [row("a.tex"), row("a.tex")] },                                    // duplicate (also unsorted)
      { members: [row("A.tex"), row("a.tex")] },                                    // case-aliased rows (one physical leaf)
      { members: [{ ...row("a.tex"), extra: 1 }] },                                 // unknown entry key
      { members: [row(`${BUNDLE_FILE}.manifest.json`)] },                           // reserved sidecar name
      { members: [row("a.pdf")] },                                                  // extension outside the allowlist
      { members: [{ fileName: "a.tex", sha256: shaOf(bytes("x")), bytes: 1.5 }] },  // non-integer bytes
    ];
    for (const plant of plants) {
      const root = await makeMembersRoot("members-planted");
      await writeBundle(root, twoMembers());
      const ref = await plantBundleBody(root, JSON.stringify(plant));
      expect((await resolveBundle(root, ref)).health, JSON.stringify(plant)).toBe("artifact-schema-invalid");
    }
  }, 120_000);

  it("reserved names are judged ALIAS-insensitively (unit: an allowlist admitting .json still refuses case variants)", () => {
    const def = {
      fileName: BUNDLE_FILE, contentKind: "json", maxBytes: 65536,
      members: { maxCount: 4, maxMemberBytes: 4096, maxTotalBytes: 8192 }, // no extension allowlist: reserved is the ONLY guard
    } as ArtifactTypeDef;
    for (const name of ["BUNDLE.JSON", "x.MANIFEST.JSON", "Bundle.Json"]) {
      const body = JSON.stringify({ members: [{ fileName: name, sha256: shaOf(bytes("x")), bytes: 1 }] });
      expect(validateMemberManifestBody(def, body).join("; "), name).toMatch(/reserved/);
    }
  });

  it("the overflow-checked total refuses instead of wrapping (unit, huge synthetic ceilings)", () => {
    const def = {
      fileName: BUNDLE_FILE, contentKind: "json", maxBytes: 65536,
      members: { maxCount: 4, maxMemberBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER },
    } as ArtifactTypeDef;
    const huge = Number.MAX_SAFE_INTEGER - 1;
    const body = JSON.stringify({ members: [
      { fileName: "a.tex", sha256: shaOf(bytes("a")), bytes: huge },
      { fileName: "b.tex", sha256: shaOf(bytes("b")), bytes: huge },
    ] });
    expect(validateMemberManifestBody(def, body)).toEqual(["member byte total overflows"]);
  });
});

describe("profile-load validation of the members declaration", () => {
  const profileWith = (def: Partial<ArtifactTypeDef>): ProfilePack => ({
    schemaVersion: 1, profileId: "members-load", entities: { note: { directory: "wiki/notes" } },
    artifacts: { [BUNDLE_TYPE]: { fileName: BUNDLE_FILE, contentKind: "json", maxBytes: 65536, members: membersBlock(), ...def } as ArtifactTypeDef },
  });

  it("loads the well-formed members declaration", () => {
    expect(() => validateProfile(profileWith({}))).not.toThrow();
  });

  it("REFUSES members with metadata (exclusive), on text contentKind, and an unknown members key", () => {
    expect(() => validateProfile(profileWith({ metadata: { note: { type: "string" } } }))).toThrow(/mutually exclusive/);
    expect(() => validateProfile(profileWith({ contentKind: "text", fileName: "bundle.txt" }))).toThrow(ProfileValidationError);
    const raw = profileWith({}) as unknown as { artifacts: Record<string, { members: Record<string, unknown> }> };
    raw.artifacts[BUNDLE_TYPE]!.members.bogus = 1;
    expect(() => validateProfile(raw as unknown as ProfilePack)).toThrow(/unknown key 'bogus'/);
  });

  it("REFUSES exactNames without requiredNames, and a requiredName failing the extension allowlist", () => {
    expect(() => validateProfile(profileWith({ members: membersBlock({ exactNames: true }) }))).toThrow(/exactNames/);
    expect(() => validateProfile(profileWith({ members: membersBlock({ requiredNames: ["main.pdf"] }) }))).toThrow(/allowedExtensions/);
  });

  it("REFUSES case-aliased requiredNames — the manifest contract could never satisfy both rows", () => {
    expect(() => validateProfile(profileWith({ members: membersBlock({ requiredNames: ["a.tex", "A.tex"] }) })))
      .toThrow(/unique \(case\/unicode-insensitively\)/);
  });

  it("REFUSES a maxBytes that cannot hold the required members' manifest (every write would be unsatisfiable)", () => {
    expect(() => validateProfile(profileWith({ maxBytes: 13 }))).toThrow(/cannot hold the manifest/); // {"members":[]} is 14 bytes
    expect(() => validateProfile(profileWith({ maxBytes: 20, members: membersBlock({ requiredNames: ["main.tex"] }) })))
      .toThrow(/cannot hold the manifest/);
  });
});
