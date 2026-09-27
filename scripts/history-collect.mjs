import { localConnection, postgresDatabase } from "../src/lib/history/database.ts";
import { collectHistory } from "../src/lib/history/collector.ts";
import { INTERVAL_SECONDS } from "../src/lib/history/constants.ts";
import { syncDueGames } from "../src/lib/linked-games/sync.ts";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--watch", "--configured"].includes(flag))) throw new Error("Supported flags: --watch, --configured");
// Local is the default, even if the shell happens to contain a production DATABASE_URL.
const connection = flags.has("--configured") ? process.env.DATABASE_URL : await localConnection();
if (!connection) throw new Error("Start the local database first, or supply DATABASE_URL with --configured.");
const database = postgresDatabase(connection);
// Linked games' private metrics sync on the same schedule, with keys sealed by the app's secrets key. Against a
// configured database that key must come from ROMANUM_SECRETS_KEY: a local one couldn't open them.
const syncPrivate = !flags.has("--configured") || Boolean(process.env.ROMANUM_SECRETS_KEY);
if (!syncPrivate) console.error("ROMANUM_SECRETS_KEY isn't set, so linked games won't sync.");
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
    if (syncPrivate) {
      try { console.log(JSON.stringify({ linkedGamesSynced: await syncDueGames(database) })); }
      catch { console.error("Syncing linked games failed. Each game keeps its last sync."); }
    }
    if (!flags.has("--watch") || stop) break;
    const period = INTERVAL_SECONDS * 1000;
    await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, period - Date.now() % period + 50); });
  } while (!stop);
} finally { await database.close(); }
