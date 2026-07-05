/**
 * Minimal .env.local reader shared by the scripts: KEY=VALUE per line,
 * surrounding quotes stripped, existing process.env keys win.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotenvLocal(root: string): void {
  const path = resolve(root, ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key in process.env) continue;
    process.env[key] = val.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}
