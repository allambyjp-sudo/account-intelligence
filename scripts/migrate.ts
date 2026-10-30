import { connect } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { loadEnv } from "./env";

async function main() {
  loadEnv();
  const { pool } = connect();
  try {
    await runMigrations(pool, console.log);
    console.log("migrations up to date");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
