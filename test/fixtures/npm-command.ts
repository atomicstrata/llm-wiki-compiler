/**
 * Invoke npm without a shell or a Windows .cmd shim. npm/npx expose their JS
 * launcher path to child tests; standalone POSIX runners can still use PATH.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Resolve the npm launcher, including when this suite was started through npx. */
export function npmCommand(args: string[]): [string, string[]] {
  const launcher = process.env.npm_execpath;
  if (launcher) {
    const cli = path.join(path.dirname(launcher), "npm-cli.js");
    if (existsSync(cli)) return [process.execPath, [cli, ...args]];
  }
  return ["npm", args];
}
