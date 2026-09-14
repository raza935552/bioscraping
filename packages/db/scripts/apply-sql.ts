// Apply .sql files statement by statement. drizzle-kit push hangs on its
// interactive rename prompt in this repo, so schema changes ship as SQL.
// Idempotent: a column, index, or table that already exists (or a column
// already dropped) is skipped, so the whole directory can be re-run on
// every deploy.
//   pnpm --filter @biolinx/db apply-sql sql                     # every file, in name order
//   pnpm --filter @biolinx/db apply-sql sql/2026-09-14-sourcing.sql
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "@biolinx/core";
import mysql from "mysql2/promise";

loadEnv();
const target = process.argv[2];
if (!target) throw new Error("usage: apply-sql <file.sql | directory>");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const files = statSync(target).isDirectory()
  ? readdirSync(target)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => path.join(target, f))
  : [target];

const SKIP_CODES = new Set(["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME", "ER_TABLE_EXISTS_ERROR", "ER_CANT_DROP_FIELD_OR_KEY"]);

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
try {
  for (const file of files) {
    console.log(`▸ ${path.basename(file)}`);
    const statements = readFileSync(file, "utf8")
      .split(/;\s*\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sql of statements) {
      const label = sql.slice(0, 60).replace(/\s+/g, " ");
      try {
        await conn.query(sql);
        console.log(`  ok: ${label}…`);
      } catch (err) {
        const code = (err as { code?: string }).code ?? "";
        if (SKIP_CODES.has(code)) {
          console.log(`  skip (already applied): ${label}…`);
          continue;
        }
        throw err;
      }
    }
  }
} finally {
  await conn.end();
}
