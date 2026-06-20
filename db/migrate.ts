import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool } from "pg";

// One-shot schema apply for local dev and CI. Production uses your real
// migration tool (Supabase declarative schemas, Prisma migrate, etc); this just
// gets the demo running with `npm run db:migrate`.
const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const sql = await readFile(join(here, "schema.sql"), "utf8");
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(sql);
    process.stdout.write("Schema applied.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exit(1);
});
