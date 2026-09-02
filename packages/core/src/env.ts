// Load the repo-root .env into process.env (no override of existing vars).
// Node 22's built-in loader — no dotenv dependency. Apps call this first.

import { existsSync } from "node:fs";
import path from "node:path";

export function loadEnv(startDir = process.cwd()): void {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // existing vars win; malformed lines are ignored by the loader
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
