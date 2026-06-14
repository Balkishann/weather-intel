import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: Database | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 10, keepAlive: true });
    // Neon (and most managed Postgres) terminate idle pooled connections. Without an
    // 'error' listener, such a drop surfaces as an unhandled 'error' event that crashes
    // the process mid-collection. Logging here lets pg evict the dead client and recover.
    pool.on("error", (err) => {
      console.error("[db] idle pool client error (will be evicted):", err.message);
    });
  }
  return pool;
}

export function getDb(connectionString?: string): Database {
  if (!db) {
    db = drizzle(getPool(connectionString), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
