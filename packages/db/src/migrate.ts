import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb, closeDb } from "./client.js";

/** Applies generated SQL migrations from ./drizzle. Idempotent. */
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  // Load the monorepo-root .env (cwd is packages/db when run via pnpm --filter).
  loadEnv({ path: resolve(here, "../../../.env") });
  const migrationsFolder = resolve(here, "../drizzle");
  const db = getDb();
  console.log(`Applying migrations from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied.");
  await closeDb();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
