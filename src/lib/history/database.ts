import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { connectionOptions } from "./connection.ts";

export interface Sql {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
}
export interface Database extends Sql {
  transaction<T>(operation: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function postgresDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ ...connectionOptions(connectionString), max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
  // Pool errors must not terminate the web process or print connection credentials.
  pool.on("error", () => console.error("History database connection failed."));
  const adapter = (client: Pick<pg.Pool, "query"> | pg.PoolClient): Sql => ({
    async query<T>(text: string, values?: unknown[]) { return { rows: (await client.query(text, values)).rows as T[] }; },
    async exec(text) { await client.query(text); },
  });
  return {
    ...adapter(pool),
    async transaction(operation) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(adapter(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    async close() { await pool.end(); },
  };
}

export async function localConnection(): Promise<string | null> {
  try {
    const config = JSON.parse(await readFile(path.join(process.cwd(), ".local", "history", "connection.json"), "utf8"));
    const url = new URL(config.url);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/romanum_local") throw new Error("Invalid local history configuration.");
    return url.href;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

let shared: { url: string; database: Database } | undefined;
export async function historyDatabase(): Promise<Database | null> {
  const url = process.env.DATABASE_URL || (process.env.NODE_ENV !== "production" ? await localConnection() : null);
  if (!url) return null;
  if (!shared || shared.url !== url) {
    if (shared) await shared.database.close();
    shared = { url, database: postgresDatabase(url) };
  }
  return shared.database;
}
