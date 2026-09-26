import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "./database.ts";

export async function migrateHistory(database: Database) {
  // The legacy entrypoint now applies the ordered application migrations as well.
  const directory = path.join(process.cwd(), "db", "migrations");
  const files = (await readdir(directory)).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  const migrations = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(directory, file), "utf8");
    return { version: Number(file.slice(0, 3)), source, checksum: createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex") };
  }));
  if (!migrations.length || migrations.some((migration, index) => migration.version !== index + 1)) throw new Error("Migration versions must be unique and consecutive from 001.");
  await database.exec("CREATE TABLE IF NOT EXISTS romanum_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  await database.transaction(async (sql) => {
    await sql.exec("LOCK TABLE romanum_migrations IN EXCLUSIVE MODE");
    const { rows } = await sql.query<{ version: number; checksum: string }>("SELECT version, checksum FROM romanum_migrations ORDER BY version");
    if (rows.some((row, index) => row.version !== index + 1 || migrations[index]?.checksum !== row.checksum)) throw new Error("Applied migration has changed or is missing. Add a new migration instead.");
    for (const { version, source, checksum } of migrations.slice(rows.length)) {
      await sql.exec(source);
      await sql.query("INSERT INTO romanum_migrations(version, checksum) VALUES ($1, $2)", [version, checksum]);
    }
  });
}
