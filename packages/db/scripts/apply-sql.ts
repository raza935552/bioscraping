// Apply a .sql file statement by statement. drizzle-kit push hangs on its
// interactive rename prompt in this repo, so schema changes ship as SQL.
//   pnpm --filter @biolinx/db apply-sql sql/2026-09-14-sourcing.sql
import { readFileSync } from "node:fs";
import { loadEnv } from "@biolinx/core";
import mysql from "mysql2/promise";

loadEnv();
const file = process.argv[2];
if (!file) throw new Error("usage: apply-sql <file.sql>");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const statements = readFileSync(file, "utf8")
  .split(/;\s*\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
for (const sql of statements) {
  const label = sql.slice(0, 60).replace(/\s+/g, " ");
  try {
    await conn.query(sql);
    console.log(`ok: ${label}…`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Re-runs are fine: a column or index that already exists is not an error here.
    if (code === "ER_DUP_FIELDNAME" || code === "ER_DUP_KEYNAME") {
      console.log(`skip (exists): ${label}…`);
      continue;
    }
    await conn.end();
    throw err;
  }
}
await conn.end();
