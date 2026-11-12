/** Terminal snippets preserve argument boundaries without executing candidate text. */
import { it, expect } from "bun:test";
import { execFileSync } from "node:child_process";
// Browser module is plain JavaScript by design.
// @ts-expect-error No declaration file for the browser-only module.
import { reviewCommand } from "../src/viewer/assets/viewer-source-command.js";

it("quotes project directories and proposal IDs as single shell arguments", () => {
  const root = "/tmp/a ' quoted $(echo bad) directory";
  const id = "--help'; echo bad; '";
  const command = reviewCommand(root, id);
  const script = 'cd() { printf "%s\\n" "$@"; }; llmwiki() { printf "%s\\n" "$@"; };\n' + command;
  expect(execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" }).split("\n"))
    .toEqual(["--", root, "review", "show", "--", id, ""]);
});

it("uses generation only when no proposal is selected and refuses control characters", () => {
  expect(reviewCommand("/tmp/project")).toBe("cd -- '/tmp/project' &&\nllmwiki compile --review");
  expect(reviewCommand(undefined, "id")).toBeNull();
  expect(reviewCommand("/tmp/a\npath", "id")).toBeNull();
  expect(reviewCommand("/tmp/path", "id\u001b")).toBeNull();
});
