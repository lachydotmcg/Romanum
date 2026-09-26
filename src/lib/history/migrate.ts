import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "./database.ts";

export async function migrateHistory(database: Database) {
  const source = await readFile(path.join(process.cwd(), "db", "migrations", "001_history.sql"), "utf8");
  const checksum = createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
  await database.exec("CREATE TABLE IF NOT EXISTS romanum_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  await database.transaction(async (sql) => {
    await sql.exec("LOCK TABLE romanum_migrations IN EXCLUSIVE MODE");
    const { rows } = await sql.query<{ checksum: string }>("SELECT checksum FROM romanum_migrations WHERE version = 1");
    if (rows[0]) {
      if (rows[0].checksum !== checksum) throw new Error("Applied history migration has changed. Add a new migration instead.");
      return;
    }
    await sql.exec(source);
    await sql.query("INSERT INTO romanum_migrations(version, checksum) VALUES (1, $1)", [checksum]);
  });
}
