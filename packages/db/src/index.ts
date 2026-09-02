import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import * as schema from "./schema.js";

export * as schema from "./schema.js";
export * from "./program.js";
export * from "./settings.js";

export interface Connection {
  db: ReturnType<typeof makeDb>;
  pool: Pool;
}

export type Db = Connection["db"];

const makeDb = (pool: Pool) => drizzle(pool, { schema, mode: "default" });

export function connect(databaseUrl = process.env.DATABASE_URL): Connection {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 10 });
  return { db: makeDb(pool), pool };
}

export function createDb(databaseUrl = process.env.DATABASE_URL): Db {
  return connect(databaseUrl).db;
}

/**
 * MySQL named lock (GET_LOCK) — the no-Redis overlap guard for scheduled
 * jobs. Lock is per-connection, so we pin one connection for the duration.
 * Returns null (skipped) when the lock is already held elsewhere.
 */
export async function withMysqlLock<T>(
  pool: Pool,
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SELECT GET_LOCK(?, 0) AS got", [name]);
    const got = (rows as Array<{ got: number | null }>)[0]?.got === 1;
    if (!got) return null;
    try {
      return await fn();
    } finally {
      await conn.query("SELECT RELEASE_LOCK(?)", [name]);
    }
  } finally {
    conn.release();
  }
}
