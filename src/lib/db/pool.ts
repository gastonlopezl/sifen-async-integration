import pg from "pg";
import type { Pool as PgPool, PoolClient } from "pg";
import { env } from "@/lib/env";

// pg is CommonJS; the named-export form breaks under native ESM (Node, tsx).
// Pull Pool off the default export so it works under the bundler and under raw
// node --test. Types come from a separate `import type`.
const { Pool } = pg;

// One pool per process. At module scope this is the ONE kind of state that
// belongs here: a reusable client, never per-request data. The Next app can
// point DATABASE_URL at the pooler; the worker points it at the direct
// connection because LISTEN/NOTIFY does not survive a transaction pooler.
declare global {
  // eslint-disable-next-line no-var
  var __sifenPgPool: PgPool | undefined;
}

function getPool(): PgPool {
  if (globalThis.__sifenPgPool) return globalThis.__sifenPgPool;
  const created = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  globalThis.__sifenPgPool = created;
  return created;
}

export const pool: PgPool = new Proxy({} as PgPool, {
  get(_target, prop: string) {
    const value = getPool()[prop as keyof PgPool];
    return typeof value === "function" ? value.bind(getPool()) : value;
  },
});

// Run a function inside a single transaction. The client is always released, on
// success and on failure, so a thrown query can never leak a connection.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
