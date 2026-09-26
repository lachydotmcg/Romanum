import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { postgresDatabase } from "../src/lib/history/database.ts";
import { migrateHistory } from "../src/lib/history/migrate.ts";

const root = path.resolve(".local/history");
await mkdir(root, { recursive: true });
const configPath = path.join(root, "connection.json");
let config;
try { config = JSON.parse(await readFile(configPath, "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  const password = randomBytes(32).toString("hex");
  config = { url: `postgresql://romanum:${password}@127.0.0.1:55432/romanum_local` };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
}
const url = new URL(config.url);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/romanum_local" || url.port !== "55432") throw new Error("Unexpected local database configuration.");
const databaseDir = path.join(root, "postgres");
const database = new EmbeddedPostgres({
  databaseDir, user: url.username, password: url.password, port: 55432,
  persistent: true, authMethod: "scram-sha-256", createPostgresUser: false,
  postgresFlags: ["-h", "127.0.0.1"], initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {}, onError: () => {},
});
let initialized = true;
try { await access(path.join(databaseDir, "PG_VERSION")); } catch { initialized = false; }
if (!initialized) await database.initialise();
await database.start();
const admin = database.getPgClient();
try {
  await admin.connect();
  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname='romanum_local'");
  if (!existing.rows.length) await admin.query("CREATE DATABASE romanum_local");
} finally { await admin.end(); }
const sql = postgresDatabase(config.url);
try { await migrateHistory(sql); } finally { await sql.close(); }
console.log("Local Postgres ready on 127.0.0.1:55432. Data: .local/history/postgres. Ctrl+C stops it; data is retained.");
let stopping = false;
const keepAlive = setInterval(() => {}, 60_000);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(keepAlive);
  await database.stop();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
