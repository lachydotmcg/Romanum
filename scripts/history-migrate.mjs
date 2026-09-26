import { localConnection, postgresDatabase } from "../src/lib/history/database.ts";
import { migrateHistory } from "../src/lib/history/migrate.ts";

const configured = process.argv.includes("--configured");
const url = configured ? process.env.DATABASE_URL : await localConnection();
if (!url) throw new Error("No history database configured.");
const database = postgresDatabase(url);
try { await migrateHistory(database); console.log("History migrations applied."); }
finally { await database.close(); }
