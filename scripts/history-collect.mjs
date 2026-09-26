import { localConnection, postgresDatabase } from "../src/lib/history/database.ts";
import { collectHistory } from "../src/lib/history/collector.ts";
import { INTERVAL_SECONDS } from "../src/lib/history/constants.ts";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--watch", "--configured"].includes(flag))) throw new Error("Supported flags: --watch, --configured");
// Local is the default, even if the shell happens to contain a production DATABASE_URL.
const connection = flags.has("--configured") ? process.env.DATABASE_URL : await localConnection();
if (!connection) throw new Error("Start the local database first, or supply DATABASE_URL with --configured.");
const database = postgresDatabase(connection);
let stop = false;
let timer;
let wake;
function shutdown() { stop = true; clearTimeout(timer); wake?.(); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  do {
    try { console.log(JSON.stringify(await collectHistory(database))); }
    catch { console.error("Collection failed. The run is recorded as failed where the database is reachable."); if (!flags.has("--watch")) process.exitCode = 1; }
    if (!flags.has("--watch") || stop) break;
    const period = INTERVAL_SECONDS * 1000;
    await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, period - Date.now() % period + 50); });
  } while (!stop);
} finally { await database.close(); }
